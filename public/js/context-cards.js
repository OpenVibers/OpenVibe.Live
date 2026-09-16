/**
 * context-cards.js — the connective tissue between clips, VODs, streams and channels.
 *
 *   renderClipSourceCard(clip)        clip page: the stream this clip came from as a rich card —
 *                                     VOD thumbnail with the clip's window marked on a timeline,
 *                                     timestamp badge, the stream's activity numbers, the
 *                                     after-show report, and the other clips cut from it.
 *   renderVodContextStrip(vodId)      VOD page: activity strip (chat lines, chatters, peak/avg
 *                                     viewers, mic moments, sound commands, follows, tips,
 *                                     loudest chatters) + after-show report link.
 *   renderOfflineDiscover(username)   offline channel screen: a discover board — live now,
 *                                     hot clips, fresh reports, the star of the day, streamers
 *                                     like this one — so an empty channel still sends people
 *                                     somewhere good.
 *
 * All three read the same two endpoints: GET /api/vods/:id/context and GET /api/home/discover.
 */
(function () {
    'use strict';
    const n = (v) => Number(v || 0).toLocaleString();
    const dur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
    const durWords = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
    const go = (href) => `href="${esc(href)}" onclick="return handleLinkClick(event, '${esc(href)}')"`;
    const ago = (ts) => { try { return timeAgo(ts); } catch { return ''; } };
    const GRADE = { S: '#fbbf24', A: '#a78bfa', B: '#38bdf8', C: '#94a3b8' };
    const av = (u, size) => `<span class="cc-avatar" style="width:${size}px;height:${size}px;${u && u.profile_color ? `background:${esc(u.profile_color)}` : ''}">${u && u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy">` : esc(String((u && (u.display_name || u.username)) || '?').charAt(0).toUpperCase())}</span>`;
    const statPills = (st) => {
        if (!st) return '';
        const items = [
            ['fa-eye', n(st.peak_viewers), 'peak'],
            st.avg_viewers != null ? ['fa-chart-line', n(st.avg_viewers), 'avg'] : null,
            ['fa-comments', n(st.chat_messages), 'chat lines'],
            ['fa-users', n(st.chatters), 'chatters'],
            st.mic_moments ? ['fa-microphone-lines', n(st.mic_moments), 'mic moments'] : null,
            st.sound_commands ? ['fa-volume-high', n(st.sound_commands), 'sounds'] : null,
            st.follows_gained ? ['fa-heart', `+${n(st.follows_gained)}`, 'follows'] : null,
            st.tips && st.tips.n ? ['fa-coins', n(st.tips.t), `in ${st.tips.n} tip${st.tips.n === 1 ? '' : 's'}`] : null,
        ].filter(Boolean);
        return `<div class="cc-stats">${items.map(([i, v, l]) => `<span class="cc-stat"><i class="fa-solid ${i}"></i><b>${v}</b><small>${esc(l)}</small></span>`).join('')}</div>`;
    };
    const clipTile = (c, opts = {}) => `<a class="cc-clip" ${go(`/clip/${c.id}`)} title="${esc(c.title || 'Clip')}">
        ${c.thumbnail_url ? `<img src="${esc(c.thumbnail_url)}" alt="" loading="lazy">` : '<span class="cc-clip-ph"><i class="fa-solid fa-scissors"></i></span>'}
        <span class="cc-clip-dur">${dur(c.duration_seconds)}</span>
        ${opts.at && c.start_time != null ? `<span class="cc-clip-at"><i class="fa-regular fa-clock"></i> ${dur(c.start_time)}</span>` : ''}
        <span class="cc-clip-title">${esc(c.title || 'Clip')}</span>
        <span class="cc-clip-meta">${c.view_count ? `<i class="fa-solid fa-eye"></i> ${n(c.view_count)} · ` : ''}${c.display_name || c.by ? esc(c.display_name || c.by) : ''}${c.created_at ? ` · ${esc(ago(c.created_at))}` : ''}</span>
    </a>`;

    async function fetchContext(vodId) {
        if (!vodId) return null;
        try { return await api(`/vods/${encodeURIComponent(vodId)}/context`); } catch { return null; }
    }

    // ── Clip page: "From this stream" card ─────────────────────
    window.renderClipSourceCard = async function (clip) {
        const host = document.getElementById('clp-stream-source');
        if (!host || !clip) return;
        const ctx = await fetchContext(clip.vod_id);
        if (!ctx || !ctx.vod) return;                          // keep the plain text fallback
        const total = Math.max(1, ctx.vod.duration_seconds || 0);
        const start = Math.max(0, Number(clip.start_time) || 0), end = Math.min(total, Math.max(start + 1, Number(clip.end_time) || start + (clip.duration_seconds || 0)));
        const left = Math.min(100, start / total * 100), width = Math.max(0.8, (end - start) / total * 100);
        const canWatch = clip.vod_available !== false && ctx.vod.visibility !== 'private';
        const vodHref = `/vod/${ctx.vod.id}?t=${Math.floor(start)}`;
        const s = ctx.stream || {}, st = ctx.stats;
        const others = (ctx.clips || []).filter(c => c.id !== clip.id).slice(0, 6);
        const rc = ctx.recap;
        host.classList.add('cc-host');
        host.innerHTML = `
            <div class="cc-card">
                <div class="cc-kicker"><i class="fa-solid fa-tower-broadcast"></i> From this stream</div>
                <div class="cc-main">
                    <a class="cc-thumb" ${canWatch ? go(vodHref) : 'href="#" onclick="return false"'} title="${canWatch ? 'Watch this moment in the full VOD' : 'VOD unavailable'}">
                        ${ctx.vod.thumbnail_url ? `<img src="${esc(ctx.vod.thumbnail_url)}" alt="" loading="lazy">` : '<span class="cc-clip-ph"><i class="fa-solid fa-video"></i></span>'}
                        <span class="cc-thumb-dur">${dur(total)}</span>
                        <span class="cc-thumb-play"><i class="fa-solid fa-play"></i></span>
                        <span class="cc-timeline" aria-hidden="true"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i></span>
                    </a>
                    <div class="cc-body">
                        <div class="cc-title-row">
                            <a class="cc-title" ${canWatch ? go(`/vod/${ctx.vod.id}`) : 'href="#" onclick="return false"'}>${esc(s.title || ctx.vod.title || 'Stream')}</a>
                            ${rc ? `<a class="cc-grade" ${go(`/recap/${rc.stream_id}`)} title="${esc(rc.headline || 'After-show report')}" style="--g:${GRADE[rc.grade] || GRADE.B}">${esc(rc.grade)}</a>` : ''}
                        </div>
                        <div class="cc-sub">
                            ${ctx.streamer ? `${av(ctx.streamer, 20)} <a class="cc-name" ${go(`/@${ctx.streamer.username}`)}>${esc(ctx.streamer.display_name)}</a>` : ''}
                            ${s.started_at ? `<span>· ${esc(new Date(String(s.started_at).replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}
                            ${s.category ? `<span>· ${esc(s.category)}</span>` : ''}
                            ${ctx.vod.view_count ? `<span>· <i class="fa-solid fa-eye"></i> ${n(ctx.vod.view_count)} VOD views</span>` : ''}
                        </div>
                        <div class="cc-when">
                            <span class="cc-badge"><i class="fa-regular fa-clock"></i> ${dur(start)} → ${dur(end)}</span>
                            <span class="cc-when-text">${Math.round(start / total * 100)}% into a ${durWords(total)} stream</span>
                        </div>
                        ${statPills(st)}
                        ${rc && rc.headline ? `<a class="cc-recap" ${go(`/recap/${rc.stream_id}`)}><i class="fa-solid fa-clipboard-list"></i> <b>After-show report:</b> ${esc(rc.headline)}</a>` : ''}
                        <div class="cc-actions">
                            ${canWatch ? `<a class="btn btn-primary btn-sm" ${go(vodHref)}><i class="fa-solid fa-forward"></i> Watch this moment in the VOD</a>` : '<span class="muted" style="font-size:0.8rem"><i class="fa-solid fa-eye-slash"></i> The full VOD is no longer available</span>'}
                            ${ctx.streamer ? `<a class="btn btn-outline btn-sm" ${go(`/@${ctx.streamer.username}`)}><i class="fa-solid fa-user"></i> Channel</a>` : ''}
                        </div>
                    </div>
                </div>
                ${others.length ? `<div class="cc-more"><div class="cc-more-head"><i class="fa-solid fa-scissors"></i> More clips from this stream <span class="muted">(${others.length})</span></div><div class="cc-clips">${others.map(c => clipTile(c, { at: true })).join('')}</div></div>` : ''}
            </div>`;
        host.style.display = '';
    };

    // ── VOD page: activity strip ────────────────────────────────
    window.renderVodContextStrip = async function (vodId) {
        const anchor = document.getElementById('vp-stream-source');
        if (!anchor) return;
        let host = document.getElementById('vp-context');
        if (!host) { host = document.createElement('div'); host.id = 'vp-context'; host.className = 'cc-host'; anchor.insertAdjacentElement('afterend', host); }
        host.innerHTML = '';
        const ctx = await fetchContext(vodId);
        if (!ctx || !ctx.stats) { host.style.display = 'none'; return; }
        const st = ctx.stats, rc = ctx.recap;
        const top = (st.top_chatters || []).slice(0, 3);
        host.innerHTML = `
            <div class="cc-card cc-strip">
                <div class="cc-kicker"><i class="fa-solid fa-bolt"></i> The room during this stream ${ctx.stream && ctx.stream.is_live ? '<span class="cc-live">LIVE · numbers so far</span>' : ''}</div>
                ${statPills(st)}
                <div class="cc-strip-foot">
                    ${top.length ? `<span class="cc-top"><i class="fa-solid fa-ranking-star"></i> Loudest: ${top.map((t, i) => `${['🥇', '🥈', '🥉'][i]} <a ${go(`/@${t.username}`)}>${esc(t.display_name || t.username)}</a> <small>${n(t.n)}</small>`).join(' ')}</span>` : ''}
                    ${rc ? `<a class="cc-recap" ${go(`/recap/${rc.stream_id}`)}><span class="cc-grade" style="--g:${GRADE[rc.grade] || GRADE.B}">${esc(rc.grade)}</span> <b>After-show report:</b> ${esc(rc.headline || '')}</a>` : ''}
                </div>
            </div>`;
        host.style.display = '';
    };

    // ── Offline channel: discover board ─────────────────────────
    window.renderOfflineDiscover = async function (username, mountEl) {
        const host = mountEl || document.getElementById('ch-discover');
        if (!host) return;
        let d = null;
        try { d = await api(`/home/discover${username ? `?channel=${encodeURIComponent(username)}` : ''}`); } catch { d = null; }
        if (!d) { host.innerHTML = ''; return; }
        const name = d.channel ? d.channel.display_name : 'this channel';
        const sections = [];
        if ((d.live || []).length) {
            sections.push(`<section class="dsc-sec dsc-sec--live"><h4><i class="fa-solid fa-circle live-dot"></i> Live right now</h4><div class="dsc-live">${d.live.slice(0, 3).map(s => `
                <a class="dsc-live-card" ${go(`/@${s.username}`)}>
                    <span class="dsc-live-thumb">${s.thumbnail_url ? `<img src="${esc(s.thumbnail_url)}" alt="" loading="lazy">` : '<span class="cc-clip-ph"><i class="fa-solid fa-tower-broadcast"></i></span>'}<span class="dsc-live-pill">LIVE</span><span class="dsc-live-viewers"><i class="fa-solid fa-eye"></i> ${n(s.viewer_count)}</span></span>
                    <span class="dsc-live-body">${av(s, 26)}<span><b>${esc(s.display_name || s.username)}</b><small>${esc(s.title || '')}</small></span></span>
                </a>`).join('')}</div></section>`);
        }
        if ((d.clips || []).length) {
            sections.push(`<section class="dsc-sec dsc-sec--clips"><h4><i class="fa-solid fa-fire"></i> ${d.clips[0].fresh ? 'Hot clips this week' : 'Most-watched clips'} <span class="muted">across OpenVibe</span></h4><div class="cc-clips dsc-clips">${d.clips.slice(0, 6).map(c => clipTile(c)).join('')}</div></section>`);
        }
        if (d.star || (d.recaps || []).length) {
            const star = d.star ? `<a class="dsc-star" ${go(`/@${d.star.username}`)}>
                <span class="dsc-star-badge">⭐ Star of the day</span>
                ${av(d.star, 56)}
                <span class="dsc-star-body"><b>${esc(d.star.display_name)}${d.star.live ? ' <span class="dsc-live-pill">LIVE</span>' : ''}</b>${d.star.headline ? `<span class="dsc-star-head">${esc(d.star.headline)}</span>` : ''}${d.star.reason ? `<small>${esc(d.star.reason)}</small>` : ''}</span>
            </a>` : '';
            const recaps = (d.recaps || []).length ? `<div class="dsc-recaps"><div class="dsc-recaps-head"><i class="fa-solid fa-clipboard-list"></i> Fresh after-show reports</div>${d.recaps.slice(0, 4).map(r => `
                <a class="dsc-recap" ${go(`/recap/${r.stream_id}`)}>
                    <span class="cc-grade" style="--g:${GRADE[r.grade] || GRADE.B}">${esc(r.grade)}</span>
                    <span class="dsc-recap-body"><b>${esc(r.headline || r.title)}</b><small>${esc(r.display_name)} · ${esc(ago(r.ended_at))} · ${durWords(r.duration_seconds)} · peak ${n(r.peak_viewers)}${r.chat_messages ? ` · ${n(r.chat_messages)} chat lines` : ''}</small></span>
                </a>`).join('')}</div>` : '';
            sections.push(`<section class="dsc-sec dsc-sec--side">${star}${recaps}</section>`);
        }
        if ((d.similar || []).length) {
            sections.push(`<section class="dsc-sec dsc-sec--people"><h4><i class="fa-solid fa-people-group"></i> Streamers to check out</h4><div class="dsc-people">${d.similar.slice(0, 6).map(p => `
                <a class="dsc-person" ${go(`/@${p.username}`)}>${av(p, 44)}<b>${esc(p.display_name || p.username)}</b><small>${p.live ? '<span class="dsc-live-dot"></span> live now' : (p.last_live_at ? `live ${esc(ago(p.last_live_at))}` : '')}${p.followers ? ` · ${n(p.followers)} follower${p.followers === 1 ? '' : 's'}` : ''}</small>${p.same_category && p.category ? `<em>${esc(p.category)}</em>` : ''}</a>`).join('')}</div></section>`);
        }
        if (!sections.length) { host.innerHTML = ''; return; }
        const noLeft = !(d.live || []).length && !(d.clips || []).length;

        // This board is a whole second page of content sitting under an offline channel. Someone
        // who came for this streamer should meet a single line about it, not scroll past six
        // sections of other people's clips to reach the About panels. So it starts closed, and
        // the toggle carries a count — "17 things happened" is a reason to open it; "Discover" is
        // not. Opening is remembered per channel, closing forgets it again.
        const events = (d.live || []).length + (d.clips || []).length + (d.recaps || []).length;
        const KEY = 'ov_dsc_open_v1';
        const openSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } })();
        const startOpen = openSet.has(username || '');

        host.innerHTML = `
            <div class="dsc-wrap${startOpen ? ' is-open' : ''}">
                <button type="button" class="dsc-toggle" aria-expanded="${startOpen}" aria-controls="dsc-body">
                    <span class="dsc-toggle-ico" aria-hidden="true"><i class="fa-solid fa-compass"></i></span>
                    <span class="dsc-toggle-text">
                        <b>While ${esc(name)} is away</b>
                        <small>${events ? `${events} thing${events === 1 ? '' : 's'} happened on OpenVibe this week` : 'the rest of OpenVibe is right here'} · follow ${esc(name)} to get pinged when they're back</small>
                    </span>
                    ${events ? `<span class="dsc-toggle-count" aria-hidden="true">${events}</span>` : ''}
                    <span class="dsc-toggle-chev" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                </button>
                <div class="dsc-body" id="dsc-body"${startOpen ? '' : ' hidden'}>
                    <div class="dsc${noLeft ? ' dsc--noleft' : ''}">${sections.join('')}</div>
                </div>
            </div>`;

        const wrap = host.querySelector('.dsc-wrap');
        const btn = host.querySelector('.dsc-toggle');
        const body = host.querySelector('.dsc-body');
        let busy = false;
        btn.addEventListener('click', () => {
            if (busy) return;
            const opening = body.hidden;
            busy = true;
            btn.setAttribute('aria-expanded', String(opening));
            wrap.classList.toggle('is-open', opening);
            try {
                if (opening) openSet.add(username || ''); else openSet.delete(username || '');
                localStorage.setItem(KEY, JSON.stringify([...openSet]));
            } catch { /* */ }

            const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduce) { body.hidden = !opening; busy = false; return; }

            // Animate the real height rather than a max-height guess: the board's height varies by
            // an order of magnitude depending on how much happened, and a fixed max-height either
            // clips it or spends most of the transition animating empty space.
            if (opening) {
                body.hidden = false;
                const h = body.scrollHeight;
                body.style.height = '0px'; body.style.overflow = 'hidden';
                requestAnimationFrame(() => {
                    body.style.transition = 'height .42s cubic-bezier(.22,1,.36,1), opacity .3s ease';
                    body.style.opacity = '0';
                    requestAnimationFrame(() => { body.style.height = h + 'px'; body.style.opacity = '1'; });
                });
                setTimeout(() => { body.style.cssText = ''; busy = false; }, 460);
            } else {
                body.style.height = body.scrollHeight + 'px'; body.style.overflow = 'hidden';
                requestAnimationFrame(() => {
                    body.style.transition = 'height .34s cubic-bezier(.4,0,.2,1), opacity .24s ease';
                    requestAnimationFrame(() => { body.style.height = '0px'; body.style.opacity = '0'; });
                });
                setTimeout(() => { body.hidden = true; body.style.cssText = ''; busy = false; }, 370);
            }
        });
    };
})();
