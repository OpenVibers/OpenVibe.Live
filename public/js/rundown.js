/**
 * OpenVibe.Live — The Rundown: what streamers talked about, written up (server/rundown/, docs/rundown.md).
 *
 * Routes (loadRundownPage(segments) from app.js):
 *   /rundown                 the front page: on air now, the top take, stream by stream, trending topics, who's been talking
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
function _rdDay(d) {
    try {
        const day = _rdTime(d);
        const now = new Date();
        const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
        if (key(day) === key(now)) return 'Today';
        now.setDate(now.getDate() - 1);
        if (key(day) === key(now)) return 'Yesterday';
        return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return ''; }
}
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
// The same face, not a link: for inside another link (a link in a link is closed early by the browser).
function _rdFace(u, size = 36) {
    if (!u) return '';
    const inner = u.avatar_url ? `<img src="${_rdEsc(u.avatar_url)}" alt="" loading="lazy" width="${size}" height="${size}">` : `<span>${_rdEsc(_rdName(u).trim().charAt(0).toUpperCase() || '?')}</span>`;
    return `<span class="rd-av" aria-hidden="true" style="--rd-av:${size}px;--rd-c:${_rdEsc(u.profile_color || '#64748b')}">${inner}</span>`;
}
function _rdUser(u) { return u ? _rdA(_rdUserHref(u), _rdEsc(_rdName(u)), 'rd-user') : ''; }
function _rdTopicChip(t, extra = '') {
    if (!t) return '';
    const [label, color] = RD_KIND[t.kind] || RD_KIND.other;
    return _rdA(`/rundown/t/${encodeURIComponent(t.slug)}`, `${_rdEsc(t.title)}${extra}`, 'rd-chip', `${label}: ${t.title}`).replace('class="rd-chip"', `class="rd-chip" style="--rd-k:${color}"`);
}
function _rdWatch(vodId, sec, label = 'Watch') { return vodId ? _rdA(videoHref('vod', vodId, Math.max(0, Math.floor(sec || 0))), `<i class="fa-solid fa-play" aria-hidden="true"></i> ${_rdEsc(label)}${sec ? ` <span class="rd-stamp">${_rdStamp(sec)}</span>` : ''}`, 'rd-watch') : ''; }
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
    const used = RD_REACT.filter(([k]) => Number(reactions[k] || 0) > 0);
    return `<div class="rd-react" role="group" aria-label="React"><div class="rd-react-used">${used.map(([k, icon, label]) => {
        const n = Number(reactions[k] || 0);
        return `<button type="button" class="rd-react-btn${mine === k ? ' is-mine' : ''}" data-rd-react="${type}:${id}:${k}" aria-pressed="${mine === k}" aria-label="${_rdEsc(label)}${n ? `, ${n}` : ''}"><span aria-hidden="true">${icon}</span>${n ? `<b>${n}</b>` : ''}</button>`;
    }).join('')}</div><button type="button" class="rd-react-add" data-rd-react-open aria-label="Add a reaction" aria-expanded="false"><span class="rd-react-add-desktop" aria-hidden="true">☺</span><span class="rd-react-add-phone" aria-hidden="true">+😀</span></button><div class="rd-react-pop" role="group" aria-label="Choose a reaction">${RD_REACT.map(([k, icon, label]) => `<button type="button" class="rd-react-choice" data-rd-react="${type}:${id}:${k}" aria-label="${_rdEsc(label)}">${icon}</button>`).join('')}</div></div>`;
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
        <div class="rd-card-foot">${_rdReactions('segment', s.id, s.reactions, s.my_reaction)}${_rdWatch(s.vod_id, s.sec)}${_rdOwnX(s)}</div>
    </article>`;
}
function _rdEpisodeCard(e, { user = true } = {}) {
    const href = `/rundown/e/${e.stream_id}`;
    const chapters = (e.chapters || []).slice(0, 4);
    return `<article class="rd-card rd-episode">
        <div class="rd-card-top"><span class="rd-kicker">Episode</span>${_rdAudChip(e)}<time datetime="${_rdEsc(e.aired_at)}">${_rdEsc(_rdDay(e.aired_at))}${e.minutes ? ` · ${_rdLength(e.minutes)}` : ''}</time></div>
        <div class="rd-take-body">
            ${user ? `<div class="rd-take-who">${_rdAv(e.user, 48)}</div>` : ''}
            <div class="rd-take-text">
                <h3 class="rd-h3 rd-ep-title">${_rdA(href, _rdEsc(e.title))}</h3>
                ${user ? `<p class="rd-by">${_rdUser(e.user)}</p>` : ''}
                ${e.logline ? `<p class="rd-logline">${_rdEsc(e.logline)}</p>` : ''}
                ${chapters.length ? `<ol class="rd-chapters">${chapters.map((c) => `<li>${e.vod_id ? _rdA(videoHref('vod', e.vod_id, c.sec), `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`) : `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`} ${_rdEsc(c.title)}</li>`).join('')}</ol>` : ''}
                ${(e.topics || []).length ? `<div class="rd-chips">${e.topics.slice(0, 5).map((t) => _rdTopicChip(t)).join('')}</div>` : ''}
            </div>
        </div>
        <div class="rd-card-foot">${_rdReactions('episode', e.stream_id, e.reactions, e.my_reaction)}${_rdA(href, 'Read the episode <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>', 'rd-read')}</div>
    </article>`;
}
// The front page's top take: the quote leads, set large.
function _rdLead(s) {
    const q = (s.quotes || [])[0];
    return `<article class="rd-lead" id="rd-take-${s.id}">
        <div class="rd-card-top"><span class="rd-kicker">Top take</span>${_rdTopicChip(s.topic)}</div>
        ${q ? `<blockquote class="rd-lead-quote"><p>“${_rdEsc(q.text)}”</p>${q.en ? `<p class="rd-quote-en">${_rdEsc(q.en)}</p>` : ''}</blockquote>` : ''}
        <h3 class="rd-lead-title">${_rdEsc(s.title)}</h3>
        <p class="rd-lead-by">${_rdAv(s.user, 28)} ${_rdUser(s.user)} <time datetime="${_rdEsc(s.said_at)}">${_rdEsc(_rdAgo(s.said_at))}</time>${q ? ` ${_rdSpeakBtn(q.text, s.user)}` : ''}</p>
        <p class="rd-what">${_rdEsc(s.what)}</p>
        ${s.quip ? `<p class="rd-quip"><span class="rd-desk">The desk</span> ${_rdEsc(s.quip)}</p>` : ''}
        <div class="rd-card-foot">${_rdReactions('segment', s.id, s.reactions, s.my_reaction)}${_rdWatch(s.vod_id, q ? q.sec : s.sec)}</div>
    </article>`;
}
// One take inside a stream's block: on a timeline by when it was said, its quote (else what they talked about) and the quip.
function _rdBrief(s) {
    const q = (s.quotes || [])[0];
    const mentions = (s.mentions || []).map(_rdUser).join(', ');
    const stamp = `<span class="rd-stamp">${_rdStamp(s.sec)}</span>`;
    return `<article class="rd-brief" id="rd-take-${s.id}">
        <div class="rd-brief-when">${s.vod_id ? _rdA(videoHref('vod', s.vod_id, s.sec), `<i class="fa-solid fa-play" aria-hidden="true"></i>${stamp}`, 'rd-brief-play', `Watch from ${_rdStamp(s.sec)}`) : stamp}</div>
        <div class="rd-brief-body">
            ${s.topic ? `<div class="rd-brief-chip">${_rdTopicChip(s.topic)}</div>` : ''}
            <h4 class="rd-brief-title">${_rdEsc(s.title)}</h4>
            ${q ? `<p class="rd-brief-quote">“${_rdEsc(q.text)}” ${_rdSpeakBtn(q.text, s.user)}</p>${q.en ? `<p class="rd-quote-en">${_rdEsc(q.en)}</p>` : ''}` : `<p class="rd-brief-what">${_rdEsc(s.what)}</p>`}
            ${s.quip ? `<p class="rd-quip"><span class="rd-desk">The desk</span> ${_rdEsc(s.quip)}</p>` : ''}
            ${mentions ? `<p class="rd-cross"><i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i> Brought up ${mentions}</p>` : ''}
            ${_rdReactions('segment', s.id, s.reactions, s.my_reaction)}
        </div>
    </article>`;
}
// A stream on the front page: its episode (or, live, what it is so far) and its best takes.
function _rdIssue(g) {
    const href = `/rundown/e/${g.stream_id}`;
    const e = g.episode;
    const title = (e && e.title) || g.title || `${_rdName(g.user)}'s stream`;
    const when = g.live ? '<span class="rd-live-tag">Live now</span>' : `<time datetime="${_rdEsc(g.started_at)}">${_rdEsc(_rdDay(g.started_at))}</time>${g.minutes ? ` · ${_rdLength(g.minutes)}` : ''}`;
    const more = g.takes_total - g.takes.length;
    return `<section class="rd-issue${g.live ? ' is-live' : ''}" aria-labelledby="rd-issue-${g.stream_id}">
        <header class="rd-issue-head">${_rdAv(g.user, 44)}<div class="rd-issue-id">
            <p class="rd-issue-meta">${_rdUser(g.user)} · ${when}</p>
            <h3 class="rd-h3" id="rd-issue-${g.stream_id}">${_rdA(href, _rdEsc(title))}</h3>
            ${e && e.logline ? `<p class="rd-logline">${_rdEsc(e.logline)}</p>` : ''}
        </div></header>
        <div class="rd-briefs">${g.takes.map(_rdBrief).join('')}</div>
        <footer class="rd-issue-foot">${more > 0 ? `<span>${more} more take${more === 1 ? '' : 's'}</span>` : '<span></span>'}${_rdA(href, `${e ? 'Read the episode' : g.live ? 'Everything so far' : 'Everything they said'} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`, 'rd-read')}</footer>
    </section>`;
}

// ── The front page ───────────────────────────────────────────
function _rdMast(counts, stats) {
    const today = _rdDay(new Date().toISOString());
    const tiles = counts ? [['fa-hashtag', 'topics', 'Topics'], ['fa-comment', 'takes', 'Takes'], ['fa-film', 'episodes', 'Episodes']] : [];
    const spark = (series) => {
        const high = Math.max(1, ...series);
        const points = series.map((n, i) => `${i * 10},${20 - Math.round(n / high * 18)}`).join(' ');
        return `<svg class="rd-spark" viewBox="0 0 60 22" aria-hidden="true"><polyline points="${points}"/></svg>`;
    };
    return `<header class="rd-mast">
        <div class="rd-mast-line"><span class="rd-date-chip">${_rdEsc(today)}</span></div>
        <h1 class="rd-title">The Rundown</h1>
        <p class="rd-tagline">What streamers talked about, written up: the topics, their takes in their own words, and every stream as an episode.</p>
        <div class="rd-stats">${tiles.map(([icon, key, label]) => {
            const series = stats && stats[key];
            return `<div class="rd-stat"><i class="fa-solid ${icon}" aria-hidden="true"></i><strong>${series ? series[6] : Number(counts[key]) || 0}</strong><span>${label}${series ? ` today · ${Number(counts[key]) || 0} all time` : ''}</span>${series ? spark(series) : ''}</div>`;
        }).join('')}</div>
    </header>`;
}
// What a visitor can do here, under the masthead of the front page. The page said what it is and never what it is for
// ("still don't rly know wtf to do with this feature", a viewer, 2026-10-20). "Jump to the moment" opens the top take's.
function _rdHow() {
    const yours = _rdMe() && _rdMe().username ? _rdA(`/rundown/${encodeURIComponent(_rdMe().username)}#mine`, 'Your Rundown') : '<a href="/api/auth/sso/login?next=%2Frundown">Your Rundown</a>';
    return `<div class="rd-how"><p>Catch up on what was said, then jump into the moment.</p><div class="rd-how-actions"><a href="#rd-about-h">How it works</a>${yours}<a href="/rundown/topics">Follow topics</a></div></div>`;
}
function _rdOnAir(list) {
    if (!list.length) return '';
    return `<section class="rd-onair" aria-labelledby="rd-onair-h"><h2 id="rd-onair-h" class="rd-h2"><span class="rd-dot" aria-hidden="true"></span> On air now</h2>
        <ul class="rd-onair-list">${list.map((x) => `<li>${_rdA(_rdChannelHref(x.user), `${x.user.avatar_url ? `<img src="${_rdEsc(x.user.avatar_url)}" alt="" width="32" height="32" loading="lazy">` : `<span class="rd-onair-i">${_rdEsc(_rdName(x.user).charAt(0).toUpperCase())}</span>`}<span class="rd-onair-t"><b>${_rdEsc(_rdName(x.user))}</b><small>${x.talking_about ? `talking about ${_rdEsc(x.talking_about)}` : _rdEsc(x.stream_title || 'live now')}</small></span>`, 'rd-onair-item')}</li>`).join('')}</ul></section>`;
}
function _rdTrending(list) {
    return `<section class="rd-box rd-trend-box" aria-labelledby="rd-trend-h"><h2 id="rd-trend-h" class="rd-h2">Trending topics <small>this week</small></h2>
        ${list.length ? `<ol class="rd-trend">${list.map((t, i) => `<li><span class="rd-trend-n" aria-hidden="true">${i + 1}</span><div>${_rdTopicFilter(t)}
            <p class="rd-trend-meta"><span class="rd-stack" aria-hidden="true">${(t.people || []).map((p) => `<i style="--rd-c:${_rdEsc(p.profile_color || '#64748b')}">${p.avatar_url ? `<img src="${_rdEsc(p.avatar_url)}" alt="" width="20" height="20" loading="lazy">` : _rdEsc(_rdName(p).charAt(0).toUpperCase())}</i>`).join('')}</span>
            ${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'}</p></div></li>`).join('')}</ol>` : '<p class="rd-quiet">No topics yet this week.</p>'}
        ${_rdA('/rundown/topics', 'Every topic <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>', 'rd-more-link')}
    </section>`;
}
function _rdVoices(list) {
    if (!list.length) return '';
    return `<section class="rd-box rd-voices-box" aria-labelledby="rd-voices-h"><h2 id="rd-voices-h" class="rd-h2">Who's been talking</h2>
        <ul class="rd-voices">${list.map((v) => `<li>${_rdAv(v.user, 36)}<div><p class="rd-voice-name">${_rdA('/rundown?streamer=' + encodeURIComponent(v.user.username), _rdEsc(_rdName(v.user)), 'rd-user')} <small>${_rdEsc(_rdAgo(v.last_seen))}</small></p>
            ${(v.top_topics || []).length ? `<div class="rd-chips rd-chips-sm">${v.top_topics.map((t) => _rdTopicFilter(t)).join('')}</div>` : ''}</div></li>`).join('')}</ul></section>`;
}
function _rdAbout() {
    const me = _rdMe();
    return `<section class="rd-box rd-about" aria-labelledby="rd-about-h"><h2 id="rd-about-h" class="rd-h2">How the desk works</h2>
        <p>The desk reads what streamers say on stream (speech to text) and writes up what they talked about: the topic, their take, a line or two in their own words, and a quip of its own. Game sounds, videos and songs are never quoted as theirs. When a stream ends, it becomes an episode.</p>
        ${me ? `<p>${_rdA(`/rundown/${encodeURIComponent(me.username)}`, 'Your page')} · <button type="button" class="rd-link" data-rd-optout="1">Keep me out of The Rundown</button></p>` : ''}
    </section>`;
}
async function _rdMore(btn) {
    if (!_rdNext) return;
    btn.disabled = true;
    try {
        const d = await api(`/rundown/streams?before=${encodeURIComponent(_rdNext)}`);
        _rdNext = d.next;
        document.getElementById('rd-feed')?.insertAdjacentHTML('beforeend', (d.streams || []).map(_rdIssue).join(''));
        if (!_rdNext) btn.remove(); else btn.disabled = false;
    } catch { btn.disabled = false; }
}

// ── Topics ───────────────────────────────────────────────────
// The first dozen show; the rest fold under their count (the owner, 10-31: short pages by counted folds, never by
// hiding). A card's summary is a teaser of four lines: the whole of it is the topic's own page.
const RD_FIRST = 12;
function _rdTopicCard(t) {
    return `<article class="rd-card rd-topic-card">
            ${_rdTopicChip(t)}
            ${t.headline ? `<h3 class="rd-h3">${_rdA(`/rundown/t/${encodeURIComponent(t.slug)}`, _rdEsc(t.headline))}</h3>` : ''}
            ${t.summary ? `<p class="rd-what rd-what-clip">${_rdEsc(t.summary)}</p>` : ''}
            <p class="rd-trend-meta"><span class="rd-stack" aria-hidden="true">${(t.people || []).map((p) => `<i style="--rd-c:${_rdEsc(p.profile_color || '#64748b')}">${p.avatar_url ? `<img src="${_rdEsc(p.avatar_url)}" alt="" width="20" height="20" loading="lazy">` : _rdEsc(_rdName(p).charAt(0).toUpperCase())}</i>`).join('')}</span>
            ${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'} · ${_rdEsc(_rdAgo(t.last_seen_at))}</p>
        </article>`;
}
async function _rdTopics(root, query) {
    return await _rdBrowse(root, _rdPathState('/rundown/topics', new URLSearchParams(location.search)));
}
async function _rdTopic(root, slug) {
    const d = await api(`/rundown/t/${encodeURIComponent(slug)}`);
    const t = d.topic;
    _rdPreset = { key: 'topic', value: t.slug, label: t.title };
    const [label, color] = RD_KIND[t.kind] || RD_KIND.other;
    root.innerHTML = `<article class="rd-page" style="--rd-k:${color}">
        <p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')} / ${_rdA('/rundown/topics', 'Topics')}</p>
        <header class="rd-page-head"><span class="rd-kicker rd-kicker-k">${_rdEsc(label)}</span><h1 class="rd-h1">${_rdEsc(t.title)}</h1>
            ${t.headline ? `<p class="rd-deck">${_rdEsc(t.headline)}</p>` : ''}
            <p class="rd-meta">${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'} · first came up ${_rdEsc(_rdDay(t.first_seen_at))}${t.last_seen_at !== t.first_seen_at ? `, last ${_rdEsc(_rdAgo(t.last_seen_at))}` : ''}</p></header>
        ${t.summary ? `<div class="rd-summary"><span class="rd-desk">The desk</span>${_rdParas(t.summary)}</div>` : ''}
        <h2 class="rd-h2">Every take</h2>
        ${(d.takes || []).map((s) => _rdTake(s, { topic: false })).join('') || _rdEmpty('fa-comment', 'No takes on this topic right now.')}
        ${(d.citations || []).length ? `<h2 class="rd-h2">Agents that worked on this</h2><ul class="rd-onair-list">${d.citations.map((r) => `<li><a class="rd-onair-item" href="https://openvibe.report/s/${encodeURIComponent(r.id)}"><span class="rd-onair-t"><b>${_rdEsc(r.title)}</b><small>${_rdEsc(r.summary || '')} · ${_rdEsc(r.outcome || 'done')}</small></span></a></li>`).join('')}</ul>` : ''}
        ${(d.related || []).length ? `<h2 class="rd-h2">Came up alongside</h2><div class="rd-chips">${d.related.map((r) => _rdTopicChip(r)).join('')}</div>` : ''}
    </article>`;
    document.title = `${t.title} · The Rundown · OpenVibe.Live`;
}

// ── An episode ───────────────────────────────────────────────
async function _rdEpisode(root, id) {
    const d = await api(`/rundown/e/${encodeURIComponent(id)}`);
    const e = d.episode, s = d.stream, u = s.user;
    _rdOwner = d.mine && u ? String(u.username).toLowerCase() : null;
    _rdPreset = u ? { key: 'streamer', value: u.username, label: _rdName(u) } : null;
    const title = e ? e.title : (s.is_live ? `${_rdName(u)} is live` : `${_rdName(u)}'s stream`);
    root.innerHTML = `<article class="rd-page">
        <p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')} / ${u ? _rdA(_rdUserHref(u), _rdEsc(_rdName(u))) : ''}</p>
        <header class="rd-page-head rd-ep-head">
            <div class="rd-ep-who">${_rdAv(u, 56)}<div><span class="rd-kicker">${s.is_live ? '<span class="rd-dot" aria-hidden="true"></span> On air now' : 'Episode'}</span>${e && !d.mine ? _rdAudChip(e) : ''}<p class="rd-by">${_rdUser(u)} · ${_rdEsc(_rdDay(s.started_at))}${e && e.minutes ? ` · ${_rdLength(e.minutes)}` : ''}</p></div></div>
            <h1 class="rd-h1">${_rdEsc(title)}</h1>
            ${e && e.logline ? `<p class="rd-deck">${_rdEsc(e.logline)}</p>` : ''}
            <p class="rd-actions">${e ? _rdWatch(e.vod_id, 0, 'Watch the stream') : ''}${s.is_live && u ? _rdA(_rdChannelHref(u), '<i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Watch live', 'rd-watch') : ''}</p>
            ${e && d.mine ? _rdOwnTools(e) : ''}
        </header>
        ${e && e.recap ? `<div class="rd-recap">${_rdParas(e.recap)}</div>` : (s.is_live ? '<p class="rd-quiet">The episode is written when the stream ends. Here is what the desk has heard so far.</p>' : '')}
        ${e && e.chapters.length ? `<section aria-labelledby="rd-ch-h"><h2 id="rd-ch-h" class="rd-h2">Chapters</h2><ol class="rd-chapters rd-chapters-big">${e.chapters.map((c) => `<li>${e.vod_id ? _rdA(videoHref('vod', e.vod_id, c.sec), `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`) : `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`} ${c.segment_id ? `<a href="#rd-take-${c.segment_id}">${_rdEsc(c.title)}</a>` : _rdEsc(c.title)}</li>`).join('')}</ol></section>` : ''}
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
    _rdPreset = { key: 'streamer', value: u.username, label: _rdName(u) };
    const mine = !!d.mine || _rdIsMine(u);
    _rdOwner = mine ? String(u.username).toLowerCase() : null;
    const head = `<p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')}</p>
        <header class="rd-page-head rd-streamer-head">${_rdAv(u, 72)}<div><h1 class="rd-h1">${_rdEsc(_rdName(u))}</h1>
            <p class="rd-meta">${d.opted_out ? 'Kept out of The Rundown' : `${d.episodes.length} episode${d.episodes.length === 1 ? '' : 's'} · ${d.topics.length} topic${d.topics.length === 1 ? '' : 's'}`} · ${_rdA(_rdChannelHref(u), 'Channel')}</p>
            </div></header>`;
    let box = '';
    if (mine) {
        const st = await api('/rundown/settings').catch(() => null);
        if (st) box = _rdMineBox(st);
    }
    if (d.opted_out) { root.innerHTML = `<article class="rd-page">${head}${box}${_rdEmpty('fa-eye-slash', `${_rdEsc(_rdName(u))} keeps themselves out of The Rundown.`)}</article>`; _rdToMine(); return; }
    root.innerHTML = `<article class="rd-page">${head}${box}
        ${d.topics.length ? `<section aria-labelledby="rd-st-t"><h2 id="rd-st-t" class="rd-h2">What they talk about</h2><div class="rd-chips">${d.topics.map((t) => _rdTopicChip(t, t.takes > 1 ? ` <b>${t.takes}</b>` : '')).join('')}</div></section>` : ''}
        ${d.lines.length ? `<section aria-labelledby="rd-st-l"><h2 id="rd-st-l" class="rd-h2">Best lines</h2><div class="rd-lines">${d.lines.flatMap((s) => (s.quotes || []).slice(0, 1).map((q) => `<figure class="rd-line"><blockquote>“${_rdEsc(q.text)}”</blockquote>${q.en ? `<p class="rd-quote-en">${_rdEsc(q.en)}</p>` : ''}<figcaption>${_rdTopicChip(s.topic)} ${_rdSpeakBtn(q.text, u)} ${_rdWatch(s.vod_id, q.sec, 'Hear it')}</figcaption></figure>`)).join('')}</div></section>` : ''}
        <section aria-labelledby="rd-st-e"><h2 id="rd-st-e" class="rd-h2">Episodes</h2>${d.episodes.map((e) => _rdEpisodeCard(e, { user: false })).join('') || _rdEmpty('fa-film', 'No episodes yet. Every stream with talk in it becomes one.')}</section>
        ${d.crossovers.length ? `<section aria-labelledby="rd-st-c"><h2 id="rd-st-c" class="rd-h2">Crossovers</h2>${d.crossovers.map((s) => _rdTake(s)).join('')}</section>` : ''}
    </article>`;
    document.title = `${_rdName(u)} · The Rundown · OpenVibe.Live`;
    _rdToMine();
}

// ── Yours: who sees it, and deleting (RUNDOWN-CONTROLS design 2026-11-06) ─────────────────────────────────────
// Who sees an episode is the sharing system's setting (Everyone / Anyone with the link / Specific people / Only me),
// changed in the Shared Share sheet on the episode's page; the streamer's default decides what new write-ups start as.
// A recording that is stricter wins (the episode follows it). Deleting removes the rows; the recording always stays.
const RD_AUD = {
    public: ['Everyone', 'fa-earth-americas', 'Anyone can find it on The Rundown.'],
    link: ['Anyone with the link', 'fa-link', 'Left off The Rundown’s pages; its link opens it.'],
    people: ['Specific people', 'fa-user-group', 'Only the people you add on each episode.'],
    private: ['Only me', 'fa-lock', 'Nobody else sees it.'],
};
function _rdToast(msg, kind) { if (typeof toast === 'function') toast(msg, kind); }
// The page's owner as the server said (a read answers `mine`), so the owner's tools do not wait for currentUser.
let _rdOwner = null;
function _rdIsMine(u) {
    if (!u || !u.username) return false;
    const name = String(u.username).toLowerCase();
    if (_rdOwner && _rdOwner === name) return true;
    const me = _rdMe();
    return !!(me && me.username && String(me.username).toLowerCase() === name);
}
/** What a non-public item is, next to its kicker. Lists show those only to their owner; the page shows everyone. */
function _rdAudChip(item) {
    if (!item || !item.audience || item.audience === 'public') return '';
    const [label, icon] = RD_AUD[item.audience] || RD_AUD.public;
    return `<span class="rd-aud-chip"><i class="fa-solid ${icon}" aria-hidden="true"></i>${_rdEsc(item.audience_chip || label)}</span>`;
}
/** A take's delete button, for its streamer only. */
function _rdOwnX(s) {
    if (!s || !_rdIsMine(s.user)) return '';
    return `<button type="button" class="rd-own-x" data-rd-del="take:${Number(s.id)}" aria-label="Delete this take" title="Delete this take"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`;
}
/** The episode page's tools for its streamer: who sees it, Share (which changes that), and Delete. */
function _rdOwnTools(e) {
    const [label, icon, line] = RD_AUD[e.audience] || RD_AUD.public;
    const why = e.following_vod
        ? `The recording is ${_rdEsc(e.following_vod_label || 'private')}, so this episode is too. Open the recording up on openvibe.video to change it.`
        : `${_rdEsc(line)} Share changes who sees it.`;
    // The Shared Share sheet (the navbar opens it for any [data-ov-share-sheet]); kind and id add "Who can open it".
    const share = `<button type="button" class="rd-own-btn" data-ov-share-sheet data-kind="rundown-episode" data-id="${Number(e.stream_id)}"
        data-url="${_rdEsc(`${location.origin}/rundown/e/${e.stream_id}`)}" data-title="${_rdEsc(e.title)}"${e.logline ? ` data-text="${_rdEsc(e.logline)}"` : ''}><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i> Share</button>`;
    return `<section class="rd-own" aria-label="Your episode">
        <div class="rd-own-aud"><span class="rd-own-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
            <div><p class="rd-own-who">Who sees it: <b>${_rdEsc(e.audience_chip || label)}</b></p><p class="rd-own-line">${why}</p></div></div>
        <div class="rd-own-actions">${share}<button type="button" class="rd-own-btn is-danger" data-rd-del="episode:${Number(e.stream_id)}"><i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete episode</button></div>
    </section>`;
}
/** "Your Rundown", on the streamer's own page: the default for new write-ups, keeping out, and deleting it all. */
function _rdMineBox(st) {
    const opts = ['public', 'link', 'private'].concat(st.default_audience === 'people' ? ['people'] : []);
    const radios = opts.map((a) => {
        const [label, icon, line] = RD_AUD[a];
        return `<label class="rd-aud-opt"><input type="radio" name="rd-default-aud" value="${a}"${st.default_audience === a ? ' checked' : ''} data-rd-default-aud>
            <span class="rd-own-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span><span class="rd-aud-text"><b>${_rdEsc(label)}</b><small>${_rdEsc(line)}</small></span></label>`;
    }).join('');
    return `<section class="rd-box rd-mine" id="mine" aria-labelledby="rd-mine-h">
        <h2 id="rd-mine-h" class="rd-h2">Your Rundown</h2>
        <fieldset class="rd-aud-pick"${st.opted_out ? ' disabled' : ''}><legend>Who sees what the desk writes up next</legend>
            <div class="rd-aud-opts">${radios}</div>
            <p class="rd-quiet">Episodes already written keep their own setting: change one with Share on its page.</p>
        </fieldset>
        <div class="rd-mine-row"><div><p class="rd-mine-t" id="rd-out-l">Keep me out of The Rundown</p><p class="rd-quiet">${st.opted_out ? 'On: nothing about your streams is shown, and the desk does not read them.' : 'Hides everything written about your streams and stops the desk reading them. You can come back any time.'}</p></div>
            <button type="button" class="rd-switch" role="switch" aria-checked="${st.opted_out ? 'true' : 'false'}" aria-labelledby="rd-out-l" data-rd-optout="${st.opted_out ? '0' : '1'}"></button></div>
        <div class="rd-mine-row"><div><p class="rd-mine-t">Delete my Rundown</p><p class="rd-quiet">Every episode and take written about your streams, for everyone. Your recordings stay.</p></div>
            <button type="button" class="rd-own-btn is-danger" data-rd-del="all">Delete…</button></div>
    </section>`;
}
/** Arriving at /rundown/<me>#mine scrolls to the box. */
function _rdToMine() {
    if (location.hash !== '#mine') return;
    const box = document.getElementById('mine');
    if (box) box.scrollIntoView({ block: 'start' });
}
/** Draw the current Rundown page again, in place. */
function _rdReload() { loadRundownPage(location.pathname.split('/').filter(Boolean)); }

/** An in-page confirmation (role alertdialog): resolves { ok, checked }. Escape and the backdrop cancel. */
function _rdConfirm({ title, body, confirm, check = '', danger = true }) {
    return new Promise((resolve) => {
        const before = document.activeElement;
        document.body.insertAdjacentHTML('beforeend', `<div class="rd-dlg-wrap"><div class="rd-sheet-backdrop" data-rd-dlg="no"></div>
            <div class="rd-sheet rd-dlg" role="alertdialog" aria-modal="true" aria-labelledby="rd-dlg-h" aria-describedby="rd-dlg-b">
                <div class="rd-dlg-body"><h2 id="rd-dlg-h" class="rd-dlg-title">${_rdEsc(title)}</h2><p id="rd-dlg-b">${_rdEsc(body)}</p>
                ${check ? `<label class="rd-dlg-check"><input type="checkbox" id="rd-dlg-check"><span>${_rdEsc(check)}</span></label>` : ''}</div>
                <div class="rd-sheet-foot"><button type="button" class="btn btn-secondary" data-rd-dlg="no">Cancel</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-rd-dlg="yes">${_rdEsc(confirm)}</button></div>
            </div></div>`);
        const wrap = document.body.lastElementChild;
        const buttons = [...wrap.querySelectorAll('button, input')];
        const key = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); done(false); return; }
            if (ev.key !== 'Tab' || !buttons.length) return;
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
            else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        };
        function done(ok) {
            const c = wrap.querySelector('#rd-dlg-check');
            const checked = !!(c && c.checked);
            wrap.remove();
            document.removeEventListener('keydown', key, true);
            document.body.classList.remove('rd-sheet-open');
            if (before && typeof before.focus === 'function') before.focus();
            resolve({ ok, checked });
        }
        document.addEventListener('keydown', key, true);
        wrap.addEventListener('click', (ev) => { const b = ev.target.closest('[data-rd-dlg]'); if (b) done(b.dataset.rdDlg === 'yes'); });
        document.body.classList.add('rd-sheet-open');
        wrap.querySelector('.btn[data-rd-dlg="no"]').focus();
    });
}

const RD_DELETE_ASK = {
    take: { title: 'Delete this take?', body: 'It is removed for everyone, and its topic is recounted. The recording stays.', confirm: 'Delete take' },
    episode: { title: 'Delete this episode?', body: 'The write-up and all its takes are removed for everyone, and the desk will not write this stream up again unless you ask. The recording stays.', confirm: 'Delete episode' },
    all: { title: 'Delete your whole Rundown?', body: 'Every episode and take written about your streams is removed for everyone. This cannot be undone. Your recordings stay.', confirm: 'Delete everything', check: 'Keep me out of The Rundown from now on, too' },
};
async function _rdDelete(spec) {
    const [what, rawId] = String(spec || '').split(':');
    const ask = RD_DELETE_ASK[what];
    if (!ask) return;
    const answer = await _rdConfirm(ask);
    if (!answer.ok) return;
    const id = Number(rawId);
    try {
        if (what === 'take') {
            const r = await api('/rundown/delete/take', { method: 'POST', body: { id } });
            const card = document.getElementById(`rd-take-${id}`);
            if (card) card.remove();
            _rdToast(r.message || 'Deleted', 'success');
        } else if (what === 'episode') {
            const r = await api('/rundown/delete/episode', { method: 'POST', body: { stream_id: id } });
            const page = document.querySelector('#rundown-root .rd-page');
            if (page) page.innerHTML = _rdGone(r, id);
            _rdToast(r.message || 'Deleted', 'success');
        } else {
            const r = await api('/rundown/delete/all', { method: 'POST', body: { keep_out: answer.checked } });
            _rdToast(r.message || 'Deleted', 'success');
            _rdReload();
        }
    } catch (err) { _rdToast(err.message || 'That did not work', 'error'); }
}
/** What an episode page says once its streamer deleted it: the receipt, and the way back. */
function _rdGone(r, streamId) {
    const me = _rdMe();
    return `<div class="rd-gone" role="status">
        <span class="rd-own-icon"><i class="fa-solid fa-check" aria-hidden="true"></i></span>
        <h1 class="rd-h2">${_rdEsc(r.message || 'Deleted')}</h1>
        <p>The recording is still yours on openvibe.video. The desk will not write this stream up again unless you ask it to.</p>
        <p class="rd-gone-actions"><button type="button" class="rd-own-btn" data-rd-restore="${Number(streamId)}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Write this stream up again</button>
            ${me && me.username ? _rdA(`/rundown/${encodeURIComponent(me.username)}#mine`, 'Your Rundown', 'rd-own-btn') : ''}</p>
    </div>`;
}
async function _rdRestore(btn) {
    btn.disabled = true;
    try {
        await api('/rundown/restore', { method: 'POST', body: { stream_id: Number(btn.dataset.rdRestore) } });
        const p = btn.closest('.rd-gone');
        if (p) p.innerHTML = `<span class="rd-own-icon"><i class="fa-solid fa-pen-nib" aria-hidden="true"></i></span><h1 class="rd-h2">The desk will write it up again</h1><p>It reads the stream once more and the episode comes back here when it is done, with your default audience.</p>`;
    } catch (err) { btn.disabled = false; _rdToast(err.message || 'That did not work', 'error'); }
}
// The default for new write-ups saves as soon as it is picked.
document.addEventListener('change', async (e) => {
    const radio = e.target.closest && e.target.closest('[data-rd-default-aud]');
    if (!radio) return;
    try {
        const st = await api('/rundown/settings', { method: 'PUT', body: { default_audience: radio.value } });
        _rdToast(`New write-ups: ${(RD_AUD[st.default_audience] || RD_AUD.public)[0]}`, 'success');
    } catch (err) { _rdToast(err.message || 'That did not save', 'error'); _rdReload(); }
});
// After the Share sheet changes who sees an episode, the page says the new setting.
document.addEventListener('ov-share:change', (e) => {
    const d = e.detail || {};
    if (d.kind === 'rundown-episode' && location.pathname.startsWith('/rundown/e/')) _rdReload();
});

// ── The bar: search and filters ────────────────────────────────────────────────
// The state of a view is its URL: /rundown?streamer=goosely&topic=drake-and-objectives&when=week&q=baron. Every
// filter is in it, so a view can be shared, the back button works and the page never keeps a state of its own.
const RD_WHEN = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['', 'Any time']];
const RD_SHOW = [['', 'Latest'], ['takes', 'Takes'], ['episodes', 'Episodes'], ['topics', 'Topics']];
const RD_SORT = [['newest', 'Newest'], ['reacted', 'Most reacted'], ['takes', 'Most takes']];
const RD_FILTER_NAMES = { q: 'search', streamer: 'Streamer', topic: 'Topic', when: 'When', show: 'Show', sort: 'Sort', video: 'With video', following: 'Following', mentions: 'Mentions me', kind: 'Kind' };

function _rdState(query) {
    const p = query instanceof URLSearchParams ? query : new URLSearchParams(query || '');
    const one = (k) => (p.get(k) || '').trim();
    return {
        q: one('q').slice(0, 120),
        streamer: one('streamer').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8),
        topic: one('topic').slice(0, 80),
        when: ['day', 'week', 'month'].includes(one('when')) ? one('when') : '',
        show: ['takes', 'episodes', 'topics'].includes(one('show')) ? one('show') : '',
        sort: ['newest', 'reacted', 'takes'].includes(one('sort')) ? one('sort') : '',
        video: one('video') === '1',
        following: one('following') === '1',
        mentions: one('mentions') === '1',
        kind: one('kind').slice(0, 20),
        page: Math.max(1, Math.min(100, Number.parseInt(one('page'), 10) || 1)),
    };
}
/** The state as a query string: the same filters, the same order, every time. */
function _rdQuery(state) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.streamer.length) p.set('streamer', state.streamer.join(','));
    if (state.topic) p.set('topic', state.topic);
    if (state.when) p.set('when', state.when);
    if (state.show) p.set('show', state.show);
    if (state.sort) p.set('sort', state.sort);
    if (state.video) p.set('video', '1');
    if (state.following) p.set('following', '1');
    if (state.mentions) p.set('mentions', '1');
    if (state.kind) p.set('kind', state.kind);
    if (state.page > 1) p.set('page', String(state.page));
    const s = p.toString();
    return s ? '?' + s : '';
}
const _rdUrl = (state) => '/rundown' + _rdQuery(state);

// The pickers' lists (the streamers who have been talking, the topics). They are fetched once, when a picker is
// opened for the first time.
let _rdOptions = null;
let _rdOptionsBusy = false;
let _rdPicker = '';
let _rdPickQueries = { streamer: '', topic: '' };
let _rdSheetScroll = 0;
let _rdSearchTimer = null;
let _rdMoreObserver = null;
let _rdPreset = null;
const _rdTopicNames = new Map();

function _rdTopicLabel(slug) {
    return _rdTopicNames.get(slug) || String(slug || '').replace(/-/g, ' ');
}
function _rdRememberTopics(list) {
    for (const t of list || []) if (t && t.slug && t.title) _rdTopicNames.set(t.slug, t.title);
}
/** A topic as a filter: the bar's way of asking for it. */
function _rdTopicFilter(t) {
    if (!t) return '';
    const [label, color] = RD_KIND[t.kind] || RD_KIND.other;
    return _rdA('/rundown?topic=' + encodeURIComponent(t.slug), _rdEsc(t.title), 'rd-chip', label + ': ' + t.title)
        .replace('class="rd-chip"', 'class="rd-chip" style="--rd-k:' + color + '"');
}
function _rdStreamerFilter(user) {
    if (!user) return '';
    return _rdA('/rundown?streamer=' + encodeURIComponent(user.username), _rdEsc(_rdName(user)), 'rd-chip');
}
/** How many filters are on: the phone's button says how many. */
function _rdActiveCount(state, preset) {
    let n = 0;
    if (state.q) n++;
    n += state.streamer.length;
    if (state.topic) n++;
    if (state.when) n++;
    if (state.show) n++;
    if (state.sort) n++;
    if (state.video) n++;
    if (state.following) n++;
    if (state.mentions) n++;
    if (preset) n++;
    return n;
}

/** The bar: the search box and the filter chips. It is sticky under the navbar on every Rundown page. */
function _rdBar(state, preset) {
    const me = _rdMe();
    const n = _rdActiveCount(state, preset);
    const pick = (key, label, count) => '<button type="button" class="rd-pick-btn" data-rd-pick="' + key + '" aria-expanded="' + (_rdPicker === key ? 'true' : 'false') + '">' + label + (count ? '<b>' + count + '</b>' : '') + '</button>';
    const toggle = (key, label, on) => '<button type="button" class="rd-toggle' + (on ? ' is-on' : '') + '" data-rd-toggle="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
    return '<div class="rd-bar" role="search" aria-label="Search and filter The Rundown">' +
        '<div class="rd-bar-row">' +
            '<div class="rd-search">' +
                '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
                '<input id="rd-search" class="rd-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search topics, streamers, episodes" value="' + _rdEsc(state.q) + '" aria-label="Search the Rundown">' +
                (state.q ? '<button type="button" class="rd-search-clear" data-rd-clear="q" aria-label="Clear the search"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' : '') +
            '</div>' +
            '<button type="button" class="rd-sheet-btn" data-rd-sheet="open" aria-haspopup="dialog">Filters' + (n ? ' (' + n + ')' : '') + '</button>' +
        '</div>' +
        '<div class="rd-chipbar" role="group" aria-label="Filters">' +
            pick('streamer', 'Streamer', state.streamer.length) +
            pick('topic', 'Topic', state.topic ? 1 : 0) +
            pick('when', 'When', state.when ? 1 : 0) +
            pick('show', 'Show', state.show ? 1 : 0) +
            pick('sort', 'Sort', state.sort ? 1 : 0) +
            toggle('video', 'With video', state.video) +
            (me ? toggle('following', 'Following', state.following) : '') +
            (me ? toggle('mentions', 'Mentions me', state.mentions) : '') +
        '</div>' +
        '<div class="rd-pickers" id="rd-pickers"' + (_rdPicker ? '' : ' hidden') + '>' + (_rdPicker ? _rdPickerPanel(state) : '') + '</div>' +
    '</div>';
}

/** The filters that are on, as chips with a cross, and a way out of all of them. */
function _rdActiveChips(state, preset) {
    const chips = [];
    if (state.q) chips.push({ key: 'q', value: '', label: state.q });
    for (const s of state.streamer) chips.push({ key: 'streamer', value: s, label: s });
    if (state.topic) chips.push({ key: 'topic', value: state.topic, label: _rdTopicLabel(state.topic) });
    if (state.when) chips.push({ key: 'when', value: '', label: (RD_WHEN.find((w) => w[0] === state.when) || [])[1] });
    if (state.show) chips.push({ key: 'show', value: '', label: (RD_SHOW.find((s) => s[0] === state.show) || [])[1] });
    if (state.sort) chips.push({ key: 'sort', value: '', label: (RD_SORT.find((s) => s[0] === state.sort) || [])[1] });
    if (state.video) chips.push({ key: 'video', value: '', label: 'With video' });
    if (state.following) chips.push({ key: 'following', value: '', label: 'Following' });
    if (state.mentions) chips.push({ key: 'mentions', value: '', label: 'Mentions me' });
    if (preset) chips.push({ key: preset.key, value: preset.value, label: preset.label, preset: true });
    if (!chips.length) return '';
    const chip = (c) => '<span class="rd-active-chip">' + _rdEsc(c.label) +
        '<button type="button" class="rd-active-x" data-rd-clear="' + _rdEsc(c.key) + (c.value ? ':' + _rdEsc(c.value) : '') + '" aria-label="Remove ' + _rdEsc(c.label) + '"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>';
    return '<div class="rd-active" aria-label="Active filters">' + chips.map(chip).join('') +
        '<button type="button" class="rd-link rd-clear-all" data-rd-clear="all">Clear all</button></div>';
}

/** One picker's panel: a small list of choices, with a search box where the list is long. */
function _rdPickerPanel(state) {
    const o = _rdOptions || { streamers: [], topics: [] };
    const head = (title) => '<div class="rd-picker-head"><h3 class="rd-h3">' + title + '</h3><button type="button" class="rd-icon-btn" data-rd-pick-close="1" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>';
    const list = (rows) => rows.length ? '<ul class="rd-picker-list">' + rows.join('') + '</ul>' : '<p class="rd-quiet">Nothing here yet.</p>';
    const item = (key, value, on, body) => '<li><button type="button" class="rd-pick-item' + (on ? ' is-on' : '') + '" data-rd-pick-value="' + _rdEsc(key + ':' + value) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + body + '</button></li>';
    if (_rdPicker === 'streamer') {
        const q = _rdPickQueries.streamer.toLowerCase();
        const rows = (o.streamers || []).filter((s) => !q || ((s.user.username || '') + ' ' + (s.user.display_name || '')).toLowerCase().includes(q));
        return '<div class="rd-picker" role="dialog" aria-label="Streamer">' + head('Streamer') +
            '<input class="rd-picker-search" type="search" data-rd-pick-search="streamer" placeholder="Search streamers" value="' + _rdEsc(_rdPickQueries.streamer) + '" aria-label="Search streamers">' +
            list(rows.map((s) => item('streamer', s.user.username, state.streamer.includes(s.user.username),
                _rdAv(s.user, 26) + '<span class="rd-pick-name">' + _rdEsc(_rdName(s.user)) + '</span><span class="rd-pick-count">' + s.takes + ' take' + (s.takes === 1 ? '' : 's') + '</span>'))) +
            '</div>';
    }
    if (_rdPicker === 'topic') {
        const q = _rdPickQueries.topic.toLowerCase();
        const rows = (o.topics || []).filter((t) => !q || String(t.title || '').toLowerCase().includes(q));
        return '<div class="rd-picker" role="dialog" aria-label="Topic">' + head('Topic') +
            '<input class="rd-picker-search" type="search" data-rd-pick-search="topic" placeholder="Search topics" value="' + _rdEsc(_rdPickQueries.topic) + '" aria-label="Search topics">' +
            list(rows.map((t) => item('topic', t.slug, state.topic === t.slug,
                '<span class="rd-pick-name">' + _rdEsc(t.title) + '</span><span class="rd-pick-count">' + t.takes + ' take' + (t.takes === 1 ? '' : 's') + '</span>'))) +
            '</div>';
    }
    const options = _rdPicker === 'when' ? RD_WHEN : (_rdPicker === 'show' ? RD_SHOW : RD_SORT);
    const current = _rdPicker === 'when' ? state.when : (_rdPicker === 'show' ? state.show : state.sort);
    const key = _rdPicker;
    return '<div class="rd-picker" role="dialog" aria-label="' + key + '">' + head(key.charAt(0).toUpperCase() + key.slice(1)) +
        list(options.map((o2) => item(key, o2[0], current === o2[0] || (!current && !o2[0]), '<span class="rd-pick-name">' + _rdEsc(o2[1]) + '</span>'))) +
        '</div>';
}

/** The phone's sheet: the same sections as the bar's pickers, one under the other. */
function _rdSheetPanel(state) {
    const o = _rdOptions || { streamers: [], topics: [] };
    const section = (title, body) => '<section class="rd-sheet-sec"><h3 class="rd-h3">' + title + '</h3>' + body + '</section>';
    const me = _rdMe();
    const when = RD_WHEN.map((w) => '<button type="button" class="rd-sheet-btn-row' + (state.when === w[0] ? ' is-on' : '') + '" data-rd-pick-value="when:' + w[0] + '">' + _rdEsc(w[1]) + '</button>').join('');
    const show = RD_SHOW.map((w) => '<button type="button" class="rd-sheet-btn-row' + (state.show === w[0] ? ' is-on' : '') + '" data-rd-pick-value="show:' + w[0] + '">' + _rdEsc(w[1]) + '</button>').join('');
    const sort = RD_SORT.map((w) => '<button type="button" class="rd-sheet-btn-row' + (state.sort === w[0] ? ' is-on' : '') + '" data-rd-pick-value="sort:' + w[0] + '">' + _rdEsc(w[1]) + '</button>').join('');
    const toggles = [
        '<button type="button" class="rd-sheet-btn-row' + (state.video ? ' is-on' : '') + '" data-rd-toggle="video" aria-pressed="' + (state.video ? 'true' : 'false') + '">With video</button>',
        me ? '<button type="button" class="rd-sheet-btn-row' + (state.following ? ' is-on' : '') + '" data-rd-toggle="following" aria-pressed="' + (state.following ? 'true' : 'false') + '">Following</button>' : '',
        me ? '<button type="button" class="rd-sheet-btn-row' + (state.mentions ? ' is-on' : '') + '" data-rd-toggle="mentions" aria-pressed="' + (state.mentions ? 'true' : 'false') + '">Mentions me</button>' : '',
    ].join('');
    const streamers = (o.streamers || []).map((s) => '<button type="button" class="rd-sheet-btn-row' + (state.streamer.includes(s.user.username) ? ' is-on' : '') + '" data-rd-pick-value="streamer:' + _rdEsc(s.user.username) + '">' + _rdAv(s.user, 24) + '<span>' + _rdEsc(_rdName(s.user)) + '</span></button>').join('');
    const topics = (o.topics || []).map((t) => '<button type="button" class="rd-sheet-btn-row' + (state.topic === t.slug ? ' is-on' : '') + '" data-rd-pick-value="topic:' + _rdEsc(t.slug) + '">' + _rdEsc(t.title) + '</button>').join('');
    return '<div class="rd-sheet-wrap"><div class="rd-sheet-backdrop" data-rd-sheet="close"></div>' +
        '<div class="rd-sheet" role="dialog" aria-modal="true" aria-label="Filters" data-rd-sheet="panel">' +
            '<div class="rd-sheet-head"><h2 class="rd-h2">Filters</h2><button type="button" class="rd-icon-btn" data-rd-sheet="close" aria-label="Close the filters"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>' +
            '<div class="rd-sheet-body" id="rd-sheet-body">' +
                section('Streamer', '<input class="rd-picker-search" type="search" data-rd-pick-search="streamer" placeholder="Search streamers" value="' + _rdEsc(_rdPickQueries.streamer) + '" aria-label="Search streamers"><div class="rd-sheet-list">' + (streamers || '<p class="rd-quiet">No streamers yet.</p>') + '</div>') +
                section('Topic', '<input class="rd-picker-search" type="search" data-rd-pick-search="topic" placeholder="Search topics" value="' + _rdEsc(_rdPickQueries.topic) + '" aria-label="Search topics"><div class="rd-sheet-list">' + (topics || '<p class="rd-quiet">No topics yet.</p>') + '</div>') +
                section('When', '<div class="rd-sheet-list">' + when + '</div>') +
                section('Show', '<div class="rd-sheet-list">' + show + '</div>') +
                section('Sort', '<div class="rd-sheet-list">' + sort + '</div>') +
                section('More', '<div class="rd-sheet-list">' + toggles + '</div>') +
            '</div>' +
            '<div class="rd-sheet-foot"><button type="button" class="btn btn-secondary" data-rd-clear="all">Clear all</button><button type="button" class="btn btn-primary" data-rd-sheet="close">Show results</button></div>' +
        '</div></div>';
}

// ── Results ─────────────────────────────────────────────────────────────────
// A take card: the streamer, the topic chip, the title, the quote, the moment and the reactions.
function _rdTakeResult(s) {
    const q = (s.quotes || [])[0];
    return '<article class="rd-card rd-take" id="rd-take-' + s.id + '">' +
        '<div class="rd-compact-top">' + _rdAv(s.user, 28) + '<span class="rd-compact-who">' + _rdUser(s.user) + '</span>' +
        (s.topic ? _rdTopicFilter(s.topic) : '') + '<time datetime="' + _rdEsc(s.said_at) + '">' + _rdEsc(_rdAgo(s.said_at)) + '</time>' + _rdWatch(s.vod_id, s.sec) + '</div>' +
        '<h3 class="rd-h3">' + _rdEsc(s.title) + '</h3>' +
        (q ? '<blockquote class="rd-quote"><p>“' + _rdEsc(q.text) + '”</p></blockquote>' : '<p class="rd-what">' + _rdEsc(s.what) + '</p>') +
        '<div class="rd-card-foot">' + _rdReactions('segment', s.id, s.reactions, s.my_reaction) + _rdOwnX(s) + '</div>' +
    '</article>';
}
// One take inside an episode: a line, with the moment it was said.
function _rdTakeMini(s) {
    return '<div class="rd-mini">' + _rdAv(s.user, 22) + '<span class="rd-mini-title">' + _rdEsc(s.title) + '</span>' +
        (s.topic ? _rdTopicFilter(s.topic) : '') +
        (s.vod_id ? _rdA(videoHref('vod', s.vod_id, s.sec), '<i class="fa-solid fa-play" aria-hidden="true"></i> <span class="rd-stamp">' + _rdStamp(s.sec) + '</span>', 'rd-brief-play') : '') +
    '</div>';
}
// An episode card: the title, the logline, its takes folded to the top ones, and how many are folded away.
function _rdEpisodeResult(e, compact = false) {
    const takes = compact ? [] : e.takes || [];
    const folded = takes.slice(0, e.folded || 3);
    const rest = takes.slice(e.folded || 3);
    const hidden = compact ? 0 : Math.max(0, (e.takes_total || takes.length) - folded.length);
    const more = rest.length
        ? '<button type="button" class="rd-fold-btn" data-rd-fold="' + e.stream_id + '" data-rd-count="' + hidden + '">More takes (' + hidden + ')</button>' +
          '<div class="rd-fold-more" data-rd-fold-body="' + e.stream_id + '" hidden>' + rest.map(_rdTakeMini).join('') + '</div>'
        : '';
    return '<article class="rd-card rd-episode" id="rd-episode-' + e.stream_id + '">' +
        '<div class="rd-card-top"><span class="rd-kicker">Episode</span>' + _rdAudChip(e) + '<span class="rd-ep-count">' + (e.takes_total || takes.length) + ' take' + ((e.takes_total || takes.length) === 1 ? '' : 's') + '</span>' +
        '<time datetime="' + _rdEsc(e.aired_at) + '">' + _rdEsc(_rdDay(e.aired_at)) + '</time></div>' +
        '<h3 class="rd-h3">' + _rdA('/rundown/e/' + e.stream_id, _rdEsc(e.title)) + '</h3>' +
        (e.logline ? '<p class="rd-logline">' + _rdEsc(e.logline) + '</p>' : '') +
        (folded.length ? '<div class="rd-fold">' + folded.map(_rdTakeMini).join('') + '</div>' : '') +
        more +
    '</article>';
}
// The count line: "34 takes from 6 streamers".
function _rdCountLine(d, state) {
    const c = d.counts || {};
    const one = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const people = (n) => 'from ' + n + ' streamer' + (n === 1 ? '' : 's');
    if (state.show === 'topics') return one(c.topics || 0, 'topic') + ' ' + people(c.topic_people || 0);
    if (state.show === 'episodes') return one(c.episodes || 0, 'episode') + ' ' + people(c.episode_people || 0);
    if (state.show === 'takes') return one(c.takes || 0, 'take') + ' ' + people(c.take_people || 0);
    return one(c.takes || 0, 'take') + ' · ' + one(c.episodes || 0, 'episode') + ' ' + people(c.take_people || 0);
}
// Nothing matches: the way out is to drop the filter that costs the most, and the closest topics by name.
function _rdNoResults(d) {
    const s = d.suggestion || {};
    const drop = s.drop ? '<p><button type="button" class="btn btn-secondary" data-rd-drop="' + _rdEsc(s.drop) + '">Drop the ' + _rdEsc(RD_FILTER_NAMES[s.drop] || s.drop) + ' filter</button></p>' : '';
    const topics = (s.topics || []).length ? '<p class="rd-quiet">Closest topics:</p><div class="rd-chips">' + s.topics.map(_rdTopicFilter).join('') + '</div>' : '';
    return '<div class="rd-empty"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><p>Nothing matches those filters.</p>' + drop + topics + '</div>';
}
function _rdResultsHtml(d, state) {
    if (state.show === 'topics') return (d.topics || []).length ? d.topics.map(_rdTopicCard).join('') : _rdNoResults(d);
    const groups = new Map();
    for (const s of d.takes || []) {
        const id = String(s.stream_id);
        if (!groups.has(id)) groups.set(id, { at: String(s.said_at || ''), user: s.user, takes: [], episode: null });
        groups.get(id).takes.push(s);
    }
    if (state.show !== 'takes') for (const e of d.episodes || []) {
        const id = String(e.stream_id);
        if (!groups.has(id)) groups.set(id, { at: String(e.aired_at || ''), user: e.user, takes: [], episode: null });
        const group = groups.get(id);
        group.episode = e;
        if (String(e.aired_at || '') > group.at) group.at = String(e.aired_at || '');
    }
    const items = [...groups.values()].sort((a, b) => b.at.localeCompare(a.at));
    let day = '';
    return items.length ? items.map((g) => {
        const thisDay = _rdDay(g.at);
        const dayHead = thisDay !== day ? '<h2 class="rd-day" id="rd-day-' + _rdEsc(g.at.slice(0, 10)) + '"><span class="rd-date-chip">' + _rdEsc(thisDay) + '</span></h2>' : '';
        day = thisDay;
        const first = g.takes.slice(0, 3).map(_rdTakeResult).join('');
        const rest = g.takes.slice(3);
        const folded = rest.length ? '<details class="rd-group-more"><summary>' + rest.length + ' more from this episode</summary>' + rest.map(_rdTakeResult).join('') + '</details>' : '';
        const streamHead = '<p class="rd-stream-head">From ' + _rdEsc(_rdName(g.user) || 'a streamer') + '\'s ' + (g.episode ? 'episode' : 'stream') + '</p>';
        return dayHead + '<section class="rd-feed-group">' + streamHead + (g.episode ? _rdEpisodeResult(g.episode, state.show !== 'episodes') : '') + first + folded + '</section>';
    }).join('') : _rdNoResults(d);
}
// The kinds, for the topics view (the old topics page had them).
function _rdKindChips(state) {
    const href = (k) => _rdUrl({ ...state, show: 'topics', kind: k });
    const chip = (k, label, color) => {
        const a = _rdA(href(k), _rdEsc(label), 'rd-chip' + (state.kind === k ? ' is-on' : ''));
        return color ? a.replace('class="rd-chip', 'style="--rd-k:' + color + '" class="rd-chip') : a;
    };
    return '<div class="rd-chips rd-kinds" role="group" aria-label="Kind">' + chip('', 'All', '') +
        Object.entries(RD_KIND).map(([k, v]) => chip(k, v[0], v[1])).join('') + '</div>';
}
// Trending topics and who's been talking, as two rails under the bar (on the phone) and in the side column.
function _rdRails(d) {
    const trending = (d.trending || []).map(_rdTopicFilter).join('');
    const voices = (d.voices || []).map((v) => '<a class="rd-rail-item" href="/rundown?streamer=' + encodeURIComponent(v.user.username) + '">' + _rdFace(v.user, 24) + '<span>' + _rdEsc(_rdName(v.user)) + '</span></a>').join('');
    return '<div class="rd-rails">' +
        '<section class="rd-rail"><div class="rd-rail-head"><h2 class="rd-h2">Trending topics</h2>' + _rdA('/rundown/topics', 'See all', 'rd-rail-all') + '</div><div class="rd-rail-track">' + (trending || '<span class="rd-quiet">No topics yet.</span>') + '</div></section>' +
        '<section class="rd-rail"><div class="rd-rail-head"><h2 class="rd-h2">Who\'s been talking</h2>' + _rdA('/rundown?show=takes', 'See all', 'rd-rail-all') + '</div><div class="rd-rail-track">' + (voices || '<span class="rd-quiet">Nobody yet.</span>') + '</div></section>' +
    '</div>';
}

// ── The page the bar is on ──────────────────────────────────────────────────
/** The state of the page, with the old topics page asking for the topics. */
function _rdPathState(path, query) {
    const st = _rdState(query);
    if (path === '/rundown/topics' && !st.show) st.show = 'topics';
    return st;
}
function _rdSkeleton() {
    return '<div class="rd-skeletons" aria-label="Loading the Rundown">' +
        Array.from({ length: 3 }, () => '<div class="rd-skeleton"><span></span><span></span><span></span></div>').join('') + '</div>';
}
function _rdNextLink(d, state) {
    if (!d.next_page) return '';
    const href = _rdQuery({ ...state, page: d.next_page });
    return '<a id="rd-next" class="rd-next" rel="next" href="/rundown' + _rdEsc(href) + '">Load more</a>';
}
function _rdObserveMore() {
    if (_rdMoreObserver) _rdMoreObserver.disconnect();
    const next = document.getElementById('rd-next');
    if (!next || typeof IntersectionObserver === 'undefined') return;
    _rdMoreObserver = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) _rdLoadMore();
    }, { rootMargin: '600px 0px' });
    _rdMoreObserver.observe(next);
}
async function _rdLoadMore() {
    const next = document.getElementById('rd-next');
    const results = document.getElementById('rd-results');
    if (!next || !results || next.dataset.loading) return;
    next.dataset.loading = '1';
    if (_rdMoreObserver) _rdMoreObserver.disconnect();
    next.insertAdjacentHTML('beforebegin', _rdSkeleton());
    try {
        const state = _rdPathState(location.pathname, new URLSearchParams(next.search));
        const d = await api('/rundown/browse' + _rdQuery(state));
        const holder = document.createElement('div');
        holder.innerHTML = _rdResultsHtml(d, state);
        const firstDay = holder.querySelector('.rd-day');
        const lastDay = [...results.querySelectorAll('.rd-day')].pop();
        if (firstDay && lastDay && firstDay.textContent === lastDay.textContent) firstDay.remove();
        while (holder.firstChild) results.appendChild(holder.firstChild);
        next.outerHTML = _rdNextLink(d, state);
        _rdObserveMore();
    } catch (err) {
        next.textContent = 'Retry loading more';
        next.removeAttribute('data-loading');
        _rdObserveMore();
    } finally {
        document.querySelectorAll('.rd-main > .rd-skeletons').forEach((node) => node.remove());
    }
}
let _rdBarListening = false;
function _rdBarState() {
    const update = () => {
        const bar = document.querySelector('#rundown-root .rd-bar');
        if (!bar) return;
        const input = bar.querySelector('#rd-search');
        if (input) input.placeholder = window.innerWidth < 520 ? 'Search topics' : 'Search topics, streamers, episodes';
        const nav = document.querySelector('.openvibe-navbar');
        const edge = Math.max(0, nav ? nav.getBoundingClientRect().bottom : 56);
        bar.style.setProperty('--rd-nav-bottom', `${edge}px`);
        bar.classList.toggle('is-stuck', window.scrollY > 4 && bar.getBoundingClientRect().top <= edge + 2);
    };
    update();
    if (_rdBarListening) return;
    _rdBarListening = true;
    let until = 0, running = false;
    const follow = () => {
        update();
        if (performance.now() < until) requestAnimationFrame(follow);
        else running = false;
    };
    const start = () => { until = performance.now() + 400; if (!running) { running = true; requestAnimationFrame(follow); } };
    const mount = document.getElementById('navbar-mount');
    if (mount) new MutationObserver(start).observe(mount, { subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('scroll', () => { update(); start(); }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
}
async function _rdBrowse(root, state) {
    root.innerHTML = _rdBar(state, null) + _rdSkeleton();
    _rdBarState();
    const d = await api('/rundown/browse' + _rdQuery(state));
    _rdRememberTopics(d.topics);
    _rdRememberTopics(d.trending);
    root.innerHTML = _rdBar(state, null) +
        '<div id="rd-active-host">' + _rdActiveChips(state, null) + '</div>' +
        _rdMast(d.counts, d.stats) + _rdHow() +
        '<div id="rd-rails-host">' + _rdRails(d) + '</div>' +
        '<div class="rd-grid"><div class="rd-main">' +
            _rdOnAir(d.on_air || []) +
            (state.show === 'topics' ? _rdKindChips(state) : '') +
            '<p class="rd-count" id="rd-count">' + _rdCountLine(d, state) + '</p>' +
            '<div id="rd-results">' + _rdResultsHtml(d, state) + '</div>' + _rdNextLink(d, state) +
        '</div><aside class="rd-side">' + _rdTrending(d.trending || []) + _rdVoices(d.voices || []) + _rdAbout() + '</aside></div>';
    _rdBarState();
    _rdObserveMore();
    document.title = (state.q ? 'Search: ' + state.q + ' · ' : '') + 'The Rundown · OpenVibe.Live';
}
/** Only the results change while the words are typed: the page is not redrawn under the reader. */
async function _rdRefresh() {
    const state = _rdPathState(location.pathname, new URLSearchParams(location.search));
    const results = document.getElementById('rd-results');
    if (results) results.innerHTML = _rdSkeleton();
    const d = await api('/rundown/browse' + _rdQuery(state));
    _rdRememberTopics(d.topics);
    if (results) results.innerHTML = _rdResultsHtml(d, state);
    const oldNext = document.getElementById('rd-next');
    if (oldNext) oldNext.remove();
    if (results) results.insertAdjacentHTML('afterend', _rdNextLink(d, state));
    _rdObserveMore();
    const count = document.getElementById('rd-count');
    if (count) count.textContent = _rdCountLine(d, state);
    const active = document.getElementById('rd-active-host');
    if (active) active.innerHTML = _rdActiveChips(state, null);
    document.title = (state.q ? 'Search: ' + state.q + ' · ' : '') + 'The Rundown · OpenVibe.Live';
}

// ── What the bar does ──────────────────────────────────────────────────────
/** A new view: the filters in the URL, and the back button gets a step. */
function _rdGo(state) {
    state.page = 1;
    const url = _rdUrl(state);
    if (url === location.pathname + location.search) return;
    navigate(url);
}
function _rdPickValue(value) {
    const parts = String(value || '').split(':');
    const key = parts[0], val = parts.slice(1).join(':');
    const state = _rdState(new URLSearchParams(location.search));
    if (key === 'streamer') {
        const list = state.streamer.slice();
        const at = list.indexOf(val);
        if (at >= 0) list.splice(at, 1); else list.push(val);
        state.streamer = list;
    } else if (key === 'topic') state.topic = state.topic === val ? '' : val;
    else if (key === 'when') state.when = state.when === val ? '' : val;
    else if (key === 'show') state.show = state.show === val ? '' : val;
    else if (key === 'sort') state.sort = state.sort === val ? '' : val;
    _rdPicker = '';
    _rdGo(state);
}
function _rdToggleFilter(key) {
    const state = _rdState(new URLSearchParams(location.search));
    if (key === 'video') state.video = !state.video;
    else if (key === 'following') state.following = !state.following;
    else if (key === 'mentions') state.mentions = !state.mentions;
    _rdGo(state);
}
/** A cross on a filter, or "Clear all". */
function _rdClear(spec) {
    const parts = String(spec || '').split(':');
    const key = parts[0], val = parts.slice(1).join(':');
    if (key === 'all') { navigate('/rundown'); return; }
    const state = _rdState(new URLSearchParams(location.search));
    if (key === 'q') state.q = '';
    else if (key === 'streamer') state.streamer = val ? state.streamer.filter((s) => s !== val) : [];
    else if (key === 'topic') state.topic = '';
    else if (key === 'when') state.when = '';
    else if (key === 'show') state.show = '';
    else if (key === 'sort') state.sort = '';
    else if (key === 'video') state.video = false;
    else if (key === 'following') state.following = false;
    else if (key === 'mentions') state.mentions = false;
    else if (key === 'kind') state.kind = '';
    _rdGo(state);
}
async function _rdEnsureOptions() {
    if (_rdOptions || _rdOptionsBusy) return;
    _rdOptionsBusy = true;
    try { _rdOptions = await api('/rundown/options'); _rdRememberTopics(_rdOptions.topics); }
    catch { _rdOptions = { streamers: [], topics: [] }; }
    _rdOptionsBusy = false;
    _rdRenderPickers();
    _rdRenderSheet();
}
async function _rdOpenPicker(name) {
    _rdPicker = _rdPicker === name ? '' : name;
    _rdRenderPickers();
    if (_rdPicker && !_rdOptions) await _rdEnsureOptions();
}
function _rdRenderPickers() {
    const host = document.getElementById('rd-pickers');
    if (!host) return;
    host.hidden = !_rdPicker;
    host.innerHTML = _rdPicker ? _rdPickerPanel(_rdState(new URLSearchParams(location.search))) : '';
}
/** The phone's sheet: it opens over the page, and it keeps its scroll. */
function _rdSheetOpen(what) {
    const wrap = document.querySelector('.rd-sheet-wrap');
    if (what === 'open') {
        if (wrap) return;
        document.body.insertAdjacentHTML('beforeend', _rdSheetPanel(_rdState(new URLSearchParams(location.search))));
        const body = document.getElementById('rd-sheet-body');
        if (body) body.scrollTop = _rdSheetScroll;
        document.body.classList.add('rd-sheet-open');
        if (!_rdOptions) _rdEnsureOptions();
        return;
    }
    const body = document.getElementById('rd-sheet-body');
    if (body) _rdSheetScroll = body.scrollTop;
    if (wrap) wrap.remove();
    document.body.classList.remove('rd-sheet-open');
}
function _rdRenderSheet() {
    const wrap = document.querySelector('.rd-sheet-wrap');
    if (!wrap) return;
    wrap.outerHTML = _rdSheetPanel(_rdState(new URLSearchParams(location.search)));
    const body = document.getElementById('rd-sheet-body');
    if (body) body.scrollTop = _rdSheetScroll;
}
/** "More takes (9)" opens the folded ones in place. */
function _rdFold(btn) {
    const body = document.querySelector('[data-rd-fold-body="' + btn.dataset.rdFold + '"]');
    if (!body) return;
    const open = body.hasAttribute('hidden');
    if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    btn.textContent = open ? 'Show fewer takes' : 'More takes (' + (btn.dataset.rdCount || '0') + ')';
}
/** The words: results as they are typed, the URL behind them, and the back button left alone. */
async function _rdSearch(value) {
    const state = _rdState(new URLSearchParams(location.search));
    state.q = String(value || '').trim();
    state.page = 1;
    const url = _rdUrl(state);
    if (location.pathname !== '/rundown' && location.pathname !== '/rundown/topics') { navigate(url); return; }
    if (url === location.pathname + location.search) return;
    history.replaceState(null, '', url);
    await _rdRefresh();
}

// ── Router and events ────────────────────────────────────────
/** The bar, on every Rundown page. The page's own filter fills it in, so a streamer's page is the Rundown
 *  narrowed to them, and the cross on that chip is the way out of it. */
function _rdAddBar(root) {
    const state = _rdState(new URLSearchParams(location.search));
    root.insertAdjacentHTML('afterbegin', _rdBar(state, _rdPreset) + '<div id="rd-active-host">' + _rdActiveChips(state, _rdPreset) + '</div>');
}
async function loadRundownPage(segments = []) {
    const root = document.getElementById('rundown-root');
    if (!root) return;
    const [, first, second] = segments;
    _rdPreset = null;
    _rdOwner = null;
    try {
        if (first === 'topics') await _rdTopics(root, new URLSearchParams(location.search));
        else if (first === 't' && second) await _rdTopic(root, decodeURIComponent(second));
        else if (first === 'e' && second) await _rdEpisode(root, second);
        else if (first === 's' && second) await _rdStreamer(root, decodeURIComponent(second));
        else if (first) await _rdStreamer(root, decodeURIComponent(first));
        else await _rdBrowse(root, _rdPathState('/rundown', new URLSearchParams(location.search)));
        // The browse view draws its own bar; every other Rundown page gets it added on top (once).
        if (!root.querySelector('.rd-bar')) _rdAddBar(root);
    } catch (err) {
        const missing = err && err.status === 404;
        root.innerHTML = _rdEmpty(missing ? 'fa-magnifying-glass' : 'fa-plug-circle-xmark', _rdEsc(missing ? 'Nothing here. It may have been taken down, or it never existed.' : (err && err.message) || 'The Rundown could not load.'), _rdA('/rundown', 'Back to The Rundown', 'btn btn-primary'));
    }
}

document.addEventListener('click', async (e) => {
    const root = document.getElementById('rundown-root');
    if (!root || !root.contains(e.target)) return;
    const reactOpen = e.target.closest('[data-rd-react-open]');
    if (reactOpen) {
        e.preventDefault();
        const group = reactOpen.closest('.rd-react');
        document.querySelectorAll('.rd-react.is-open').forEach((node) => { if (node !== group) node.classList.remove('is-open'); });
        group.classList.toggle('is-open');
        reactOpen.setAttribute('aria-expanded', group.classList.contains('is-open') ? 'true' : 'false');
        return;
    }
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
        if (out) {
            const ok = await _rdConfirm({ title: 'Keep yourself out of The Rundown?', body: 'Everything written about your streams is hidden from everyone, and the desk stops reading them. You can come back any time.', confirm: 'Keep me out', danger: false });
            if (!ok.ok) return;
        }
        try { await api('/rundown/opt-out', { method: 'PUT', body: { out } }); _rdToast(out ? 'You are out of The Rundown.' : 'Welcome back to The Rundown.', 'success'); _rdReload(); }
        catch (err) { _rdToast(err.message || 'That did not work', 'error'); }
        return;
    }
    const del = e.target.closest('[data-rd-del]');
    if (del) { e.preventDefault(); _rdDelete(del.dataset.rdDel); return; }
    const restore = e.target.closest('[data-rd-restore]');
    if (restore) { e.preventDefault(); _rdRestore(restore); }
});
document.addEventListener('click', (e) => {
    if (e.target.closest('.rd-react')) return;
    document.querySelectorAll('.rd-react.is-open').forEach((node) => {
        node.classList.remove('is-open');
        const button = node.querySelector('[data-rd-react-open]');
        if (button) button.setAttribute('aria-expanded', 'false');
    });
});

// ── The bar's events ────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-rd-pick]');
    if (pick) { e.preventDefault(); _rdOpenPicker(pick.dataset.rdPick); return; }
    const close = e.target.closest('[data-rd-pick-close]');
    if (close) { e.preventDefault(); _rdPicker = ''; _rdRenderPickers(); return; }
    const value = e.target.closest('[data-rd-pick-value]');
    if (value) { e.preventDefault(); _rdPickValue(value.dataset.rdPickValue); return; }
    const toggle = e.target.closest('[data-rd-toggle]');
    if (toggle) { e.preventDefault(); _rdToggleFilter(toggle.dataset.rdToggle); return; }
    const clear = e.target.closest('[data-rd-clear]');
    if (clear) { e.preventDefault(); _rdClear(clear.dataset.rdClear); return; }
    const drop = e.target.closest('[data-rd-drop]');
    if (drop) { e.preventDefault(); _rdClear(drop.dataset.rdDrop); return; }
    const sheet = e.target.closest('[data-rd-sheet]');
    if (sheet) { e.preventDefault(); _rdSheetOpen(sheet.dataset.rdSheet); return; }
    const fold = e.target.closest('[data-rd-fold]');
    if (fold) { e.preventDefault(); _rdFold(fold); return; }
});

// The words: the results follow the typing, 250 ms later.
document.addEventListener('input', (e) => {
    const search = e.target.closest('#rd-search');
    if (search) {
        clearTimeout(_rdSearchTimer);
        const value = search.value;
        _rdSearchTimer = setTimeout(() => _rdSearch(value), 250);
        return;
    }
    const pickSearch = e.target.closest('[data-rd-pick-search]');
    if (pickSearch) {
        const kind = pickSearch.dataset.rdPickSearch;
        _rdPickQueries[kind] = pickSearch.value;
        _rdRenderPickers();
        _rdRenderSheet();
        const again = document.querySelector('[data-rd-pick-search="' + kind + '"]');
        if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* */ } }
    }
});

// "/" focuses the search, wherever the reader is on the page.
document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const input = document.getElementById('rd-search');
    if (!input) return;
    e.preventDefault();
    input.focus();
    input.select();
});
