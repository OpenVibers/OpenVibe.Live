'use strict';

const { frontPageOk } = require('./front-page-text');

/** Rows arrive best first. Skip unsafe or unlabelled takes before keeping three distinct topics. */
function selectTopics(rows) {
    const seen = new Set();
    return (rows || []).map((r) => {
        let quote = null;
        try { quote = JSON.parse(r.quotes_json || '[]')[0] || null; } catch { /* use the headline */ }
        return { id: r.id, stream_id: r.stream_id, text: quote?.text || r.title, topic: r.topic, kind: r.kind,
            said_at: r.said_at, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url };
    }).filter((r) => {
        if (!frontPageOk(r.text) || !frontPageOk(r.topic) || seen.has(r.topic)) return false;
        seen.add(r.topic);
        return true;
    }).slice(0, 3);
}

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const age = (value) => {
    const ms = Date.now() - Date.parse(value);
    if (!Number.isFinite(ms)) return 'recently';
    if (ms < 3600000) return `${Math.max(1, Math.floor(ms / 60000))} min ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)} h ago`;
    return `${Math.floor(ms / 86400000)} d ago`;
};
const until = (value) => {
    const ms = Date.parse(value) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'soon';
    if (ms < 3600000) return `in ${Math.max(1, Math.ceil(ms / 60000))} min`;
    if (ms < 86400000) return `in ${Math.ceil(ms / 3600000)} h`;
    return `in ${Math.ceil(ms / 86400000)} d`;
};
const avatar = (user) => user.avatar_url
    ? `<img class="digest-avatar" src="${esc(user.avatar_url)}" alt="" loading="lazy">`
    : `<span class="digest-avatar digest-avatar--initial">${esc((user.display_name || user.username || '?').slice(0, 1).toUpperCase())}</span>`;
const name = (user) => esc(user.display_name || user.username);
const delta = (value) => value > 0 ? `+${value}` : value < 0 ? `\u2212${-value}` : '\u00b10';
// One cell of the strip (owner, 2026-11-11: "look at all that wasted space for those metrics"): the number with its
// change beside it, what it counts under it, four cells on one row at every width.
const tile = (icon, label, value, change, extra = '') => {
    const c = change == null ? '' : ` <small class="digest-delta${change > 0 ? ' is-up' : change < 0 ? ' is-down' : ''}" title="Today compared with yesterday">${delta(change)}</small>`;
    return `<div class="digest-tile"><span class="digest-tile-value">${Number(value || 0).toLocaleString()}${c}</span><span class="digest-tile-label"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</span>${extra}</div>`;
};
const validProfile = (username) => /^[a-z0-9_-]{1,64}$/i.test(String(username || ''));
const profile = (u) => validProfile(u.username) ? `/@${encodeURIComponent(u.username)}` : '/';
const text = (s, max = 145) => esc(String(s || '').slice(0, max));

function render(d) {
    const active = d.stats.streams || d.stats.takes || d.stats.new_follows || d.stats.chat_lines || d.stats.new_members || d.liveNow.length || d.streamed.length || d.topics.length || d.across.length;
    const since = age(d.since);
    if (!active) {
        const next = d.nextStream;
        return `<div class="digest-head"><h2 class="digest-title">Since you were here <span>· ${esc(since)}</span></h2></div><p class="digest-empty">Nothing new since ${esc(since)}${next ? `. Next up: <a href="${profile(next)}">${text(next.title, 70)} with ${name(next)}</a> ${esc(until(next.starts_at))}` : '.'}</p>`;
    }
    const st = d.stats;
    const third = ['fa-heart', 'New follows', st.new_follows, d.changes.new_follows];
    const faces = d.newPeople.map((p) => `<a href="${profile(p)}" aria-label="${name(p)} joined OpenVibe" title="${name(p)}">${avatar(p)}</a>`).join('');
    const tiles = [tile('fa-tower-broadcast', 'Streams', st.streams, d.changes.streams), tile('fa-newspaper', 'Rundown takes', st.takes, d.changes.takes), tile(...third), tile('fa-user-plus', 'New here', st.new_members, d.changes.new_members, faces ? `<span class="digest-new-faces">${faces}</span>` : '')].join('');
    const topics = d.topics.map((t) => {
        const link = `/rundown/e/${Number(t.stream_id)}#rd-take-${Number(t.id)}`;
        return `<a class="digest-topic-row" href="${link}"><span class="digest-topic-chip digest-topic-chip--${esc(t.kind || 'other')}">${text(t.topic, 40)}</span><span class="digest-topic-text">${avatar(t)}<span><strong>${text(t.text)}</strong><small>in ${name(t)}'s stream · ${esc(age(t.said_at))}</small></span></span></a>`;
    }).join('');
    // One row a person: someone live on two slots is one row that says so, not the same face twice (2026-11-11).
    const live = [];
    for (const u of d.liveNow) {
        const had = live.find((x) => x.username === u.username);
        if (had) { had.streams += 1; had.viewer_count = Number(had.viewer_count || 0) + Number(u.viewer_count || 0); } else live.push({ ...u, live: true, streams: 1 });
    }
    const people = [...live, ...d.streamed].slice(0, 3).map((u) => {
        const go = u.watch_url || (u.live ? profile(u) : null);
        const mins = Math.max(1, Math.round(Number(u.hours || 0) * 60));
        const details = u.live
            ? `Live now${u.streams > 1 ? ` on ${u.streams} streams` : ''} · ${Number(u.viewer_count || 0)} watching`
            : `Streamed ${Number(u.sessions) === 1 ? 'once' : `${Number(u.sessions)} times`} · ${mins >= 90 ? `${Math.round(mins / 6) / 10} h` : `${mins} min`} · peak ${Number(u.peak_viewers || 0)}`;
        // The two ways in are icons with their names on them, so the person's name and line keep the row's width.
        const who = name(u);
        return `<div class="digest-person${u.live ? ' is-live' : ''}">${avatar(u)}<span class="digest-person-main"><a href="${profile(u)}">${who}</a><small>${esc(details)}</small></span><span class="digest-person-actions">${go ? `<a class="is-go" href="${esc(go)}" title="Watch" aria-label="Watch ${who}"><i class="fa-solid fa-play" aria-hidden="true"></i></a>` : ''}<a href="/rundown/${encodeURIComponent(u.username)}" title="Rundown" aria-label="${who}'s Rundown"><i class="fa-solid fa-newspaper" aria-hidden="true"></i></a></span></div>`;
    }).join('');
    const across = d.across.length ? `<div class="digest-across"><strong>Across OpenVibe</strong>${d.across.map((x) => `<a href="${esc(x.url)}"><i class="fa-solid ${esc(x.icon)}" aria-hidden="true"></i><span>${text(x.title, 62)} <small>· ${esc(x.site)}</small></span></a>`).join('')}</div>` : '';
    return `<div class="digest-head"><h2 class="digest-title">Since you were here <span>· ${esc(since)}</span></h2></div><div class="digest-tiles">${tiles}</div>${topics ? `<section class="digest-section"><h3>What they talked about</h3>${topics}</section>` : ''}${people ? `<section class="digest-section"><h3>Who streamed</h3>${people}</section>` : ''}${across}`;
}

module.exports = { render, selectTopics };
