'use strict';

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
const delta = (value) => value > 0 ? `+${value}` : String(value);
const tile = (icon, label, value, change, extra = '') => `<div class="digest-tile"><span class="digest-tile-label"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</span><span class="digest-tile-value">${Number(value || 0).toLocaleString()}${change == null ? '' : ` <small title="Today compared with yesterday">${delta(change)}</small>`}</span>${extra}</div>`;
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
    const people = [...d.liveNow.map((u) => ({ ...u, live: true })), ...d.streamed].slice(0, 3).map((u) => {
        const watch = u.watch_url || (u.live ? profile(u) : null);
        const details = u.live ? `Live now · ${Number(u.viewer_count || 0)} watching` : `streamed ${Number(u.sessions) === 1 ? 'once' : `${Number(u.sessions)} times`} · ${Math.max(1, Math.round(Number(u.hours || 0) * 60))} min · peak ${Number(u.peak_viewers || 0)} watching`;
        return `<div class="digest-person">${avatar(u)}<span class="digest-person-main"><a href="${profile(u)}">${name(u)}</a><small>${esc(details)}</small></span><span class="digest-person-actions">${watch ? `<a href="${esc(watch)}">Watch</a>` : ''}<a href="/rundown/${encodeURIComponent(u.username)}"><i class="fa-solid fa-newspaper" aria-hidden="true"></i> Rundown</a></span></div>`;
    }).join('');
    const across = d.across.length ? `<div class="digest-across"><strong>Across OpenVibe</strong>${d.across.map((x) => `<a href="${esc(x.url)}"><i class="fa-solid ${esc(x.icon)}" aria-hidden="true"></i><span>${text(x.title, 62)} <small>· ${esc(x.site)}</small></span></a>`).join('')}</div>` : '';
    return `<div class="digest-head"><h2 class="digest-title">Since you were here <span>· ${esc(since)}</span></h2></div><div class="digest-tiles">${tiles}</div>${topics ? `<section class="digest-section"><h3>What they talked about</h3>${topics}</section>` : ''}${people ? `<section class="digest-section"><h3>Who streamed</h3>${people}</section>` : ''}${across}`;
}

module.exports = { render };
