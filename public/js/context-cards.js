/**
 * context-cards.js — the connective tissue between clips, VODs, streams and channels.
 *
 *   renderOfflineDiscover(username)   offline channel screen: a discover board — live now,
 *                                     hot clips, fresh reports, the star of the day, streamers
 *                                     like this one — so an empty channel still sends people
 *                                     somewhere good.
 *
 * It reads GET /api/home/discover. (The clip page's source card and the VOD page's activity strip went with those
 * pages to OpenVibe.Video, which reads GET /api/vods/:id/context for them.)
 */
(function () {
    'use strict';
    const n = (v) => Number(v || 0).toLocaleString();
    const dur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
    const durWords = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
    // Inside Live the SPA navigates; a recording or clip opens on openvibe.video (a plain link).
    const go = (href) => (/^https?:\/\//.test(href) ? `href="${esc(href)}"` : `href="${esc(href)}" onclick="return handleLinkClick(event, '${esc(href)}')"`);
    const ago = (ts) => { try { return timeAgo(ts); } catch { return ''; } };
    const GRADE = { S: '#fbbf24', A: '#a78bfa', B: '#38bdf8', C: '#94a3b8' };
    const av = (u, size) => `<span class="cc-avatar" style="width:${size}px;height:${size}px;${u && u.profile_color ? `background:${esc(u.profile_color)}` : ''}">${u && u.avatar_url ? `<img src="${esc(typeof ovImgW === 'function' ? ovImgW(u.avatar_url, size > 72 ? 320 : size > 40 ? 160 : 96) : u.avatar_url)}" data-full="${esc(u.avatar_url)}" alt="" loading="lazy" onerror="if(this.dataset.full&&this.src!==this.dataset.full){this.src=this.dataset.full;return}">` : esc(String((u && (u.display_name || u.username)) || '?').charAt(0).toUpperCase())}</span>`;
    const clipTile = (c, opts = {}) => `<a class="cc-clip" ${go(videoHref('clip', c.id))} title="${esc(c.title || 'Clip')}">
        ${c.thumbnail_url ? `<img src="${esc(c.thumbnail_url)}" alt="" loading="lazy">` : '<span class="cc-clip-ph"><i class="fa-solid fa-scissors"></i></span>'}
        <span class="cc-clip-dur">${dur(c.duration_seconds)}</span>
        ${opts.at && c.start_time != null ? `<span class="cc-clip-at"><i class="fa-regular fa-clock"></i> ${dur(c.start_time)}</span>` : ''}
        <span class="cc-clip-title">${esc(c.title || 'Clip')}</span>
        <span class="cc-clip-meta">${c.view_count ? `<i class="fa-solid fa-eye"></i> ${n(c.view_count)} · ` : ''}${c.display_name || c.by ? esc(c.display_name || c.by) : ''}${c.created_at ? ` · ${esc(ago(c.created_at))}` : ''}</span>
    </a>`;

    // ── Offline channel: discover board ─────────────────────────
    window.renderOfflineDiscover = async function (username, mountEl) {
        const host = mountEl || document.getElementById('ch-discover');
        if (!host) return;
        let d = null;
        try { d = await api(`/home/discover${username ? `?channel=${encodeURIComponent(username)}` : ''}`); } catch { d = null; }
        if (!d) { host.innerHTML = ''; return; }
        const name = d.channel ? d.channel.display_name : 'this channel';
        const sections = [];
        let side = '';
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
            side = `<aside class="dsc-side">${star}${recaps}</aside>`;
        }
        if ((d.similar || []).length) {
            sections.push(`<section class="dsc-sec dsc-sec--people"><h4><i class="fa-solid fa-people-group"></i> Streamers to check out</h4><div class="dsc-people">${d.similar.slice(0, 6).map(p => `
                <a class="dsc-person" ${go(`/@${p.username}`)}>${av(p, 44)}<b>${esc(p.display_name || p.username)}</b><small>${p.live ? '<span class="dsc-live-dot"></span> live now' : (p.last_live_at ? `live ${esc(ago(p.last_live_at))}` : '')}${p.followers ? ` · ${n(p.followers)} follower${p.followers === 1 ? '' : 's'}` : ''}</small>${p.same_category && p.category ? `<em>${esc(p.category)}</em>` : ''}</a>`).join('')}</div></section>`);
        }
        if (!sections.length && !side) { host.innerHTML = ''; return; }

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
                    <div class="dsc${side ? '' : ' dsc--noside'}${sections.length ? '' : ' dsc--sideonly'}">${sections.length ? `<div class="dsc-main">${sections.join('')}</div>` : ''}${side}</div>
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
