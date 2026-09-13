/**
 * recap.js — the after-show report page (/recap/:streamId).
 * Renders what /api/recap/:id returns: grade + headline + AI summary, stat tiles, the viewer
 * curve with chat bars, moment of the night + mic lines, top chatters, clips, the VOD, share.
 */
(function () {
    'use strict';
    const GRADE = { S: { color: '#fbbf24', label: 'Legendary night' }, A: { color: '#a78bfa', label: 'Great night' }, B: { color: '#38bdf8', label: 'Solid night' }, C: { color: '#94a3b8', label: 'Quiet night' } };
    const n = (v) => Number(v || 0).toLocaleString();
    const dur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
    const when = (ts) => { const t = Date.parse(String(ts || '').replace(' ', 'T') + (String(ts || '').endsWith('Z') ? '' : 'Z')); return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
    const av = (u, size) => `<span class="recap-avatar" style="width:${size}px;height:${size}px;${u.profile_color ? `background:${esc(u.profile_color)}` : ''}">${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy">` : esc(String(u.display_name || u.username || '?').charAt(0).toUpperCase())}</span>`;
    const go = (href) => `href="${esc(href)}" onclick="return handleLinkClick(event, '${esc(href)}')"`;

    function curveSvg(curve, startedAt) {
        if (!curve || curve.length < 2) return '';
        const W = 720, H = 150, padL = 4, padR = 4, top = 14, base = 112, barTop = 118, barBase = 148;
        const maxV = Math.max(1, ...curve.map(p => p[1]));
        const maxC = Math.max(1, ...curve.map(p => p[2]));
        const x = (i) => padL + (i / (curve.length - 1)) * (W - padL - padR);
        const y = (v) => base - (v / maxV) * (base - top);
        const pts = curve.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`);
        const area = `M${pts[0]} L${pts.join(' L')} L${x(curve.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`;
        const line = `M${pts.join(' L')}`;
        const bw = Math.max(1.5, (W - padL - padR) / curve.length - 1);
        const bars = curve.map((p, i) => p[2] > 0 ? `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(barBase - (p[2] / maxC) * (barBase - barTop)).toFixed(1)}" width="${bw.toFixed(1)}" height="${((p[2] / maxC) * (barBase - barTop)).toFixed(1)}" rx="1" class="recap-bar"/>` : '').join('');
        let peakI = 0; curve.forEach((p, i) => { if (p[1] > curve[peakI][1]) peakI = i; });
        const t0 = Date.parse(String(startedAt || '').replace(' ', 'T') + 'Z');
        const tick = (i) => { const t = Date.parse(String(curve[i][0]).replace(' ', 'T') + 'Z'); return Number.isFinite(t) && Number.isFinite(t0) ? dur((t - t0) / 1000) : ''; };
        return `<svg class="recap-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Viewers over the stream">
            <defs><linearGradient id="rcg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity="0.55"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0.02"/></linearGradient></defs>
            <path d="${area}" fill="url(#rcg)"/><path d="${line}" fill="none" stroke="#c4b5fd" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
            ${bars}
            <circle cx="${x(peakI).toFixed(1)}" cy="${y(curve[peakI][1]).toFixed(1)}" r="4.5" fill="#fbbf24" stroke="#0b0b12" stroke-width="2"/>
        </svg>
        <div class="recap-curve-axis"><span>start</span><span>peak ${n(curve[peakI][1])} · ${tick(peakI)} in</span><span>${tick(curve.length - 1)}</span></div>`;
    }

    function render(root, data, id) {
        const r = data.recap, w = r.write || {}, s = r.stream, u = r.streamer;
        const g = GRADE[w.grade] || GRADE.B;
        const path = `/@${u.username}`;
        const owner = window.currentUser && (currentUser.id === u.id || currentUser.role === 'admin');
        const tiles = [
            ['fa-eye', n(s.peak_viewers), 'peak viewers'],
            r.viewers.avg != null ? ['fa-chart-line', n(r.viewers.avg), 'avg viewers'] : null,
            ['fa-comments', n(r.chat.messages), 'chat lines'],
            ['fa-users', n(r.chat.chatters), 'chatters'],
            ['fa-heart', `+${n(r.love.follows)}`, 'new follows'],
            r.love.tips ? ['fa-coins', n(r.love.tips_total), `in ${r.love.tips} tip${r.love.tips === 1 ? '' : 's'}`] : null,
            r.clips.length ? ['fa-scissors', n(r.clips.length), 'clips'] : null,
            r.chat.sounds ? ['fa-volume-high', n(r.chat.sounds), 'sound commands'] : null,
            r.mic.length ? ['fa-microphone-lines', n(r.mic.length), 'mic moments'] : null,
        ].filter(Boolean).map(([i, v, l]) => `<div class="recap-tile"><i class="fa-solid ${i}"></i><b>${v}</b><span>${esc(l)}</span></div>`).join('');
        const medals = ['🥇', '🥈', '🥉', '4', '5'];
        const topN = r.chat.top[0] ? r.chat.top[0].n : 1;
        const chatters = r.chat.top.length ? `<div class="recap-card"><h3><i class="fa-solid fa-ranking-star"></i> Loudest in chat</h3><ol class="recap-chatters">${r.chat.top.map((c, i) => `<li><span class="recap-medal">${medals[i]}</span>${av(c, 26)}<a class="recap-chatter-name" ${go(`/@${c.username}`)}>${esc(c.display_name || c.username)}</a><span class="recap-chatter-bar"><i style="width:${Math.max(6, Math.round(c.n / topN * 100))}%"></i></span><span class="recap-chatter-n">${n(c.n)}</span></li>`).join('')}</ol>${r.chat.busiest_at ? `<div class="recap-fine">Busiest stretch: ${esc(when(r.chat.busiest_at))} (${n(r.chat.busiest_n)} lines in 5 min)</div>` : ''}</div>` : '';
        const micLine = (m) => { const href = m.vod_id ? `/vod/${m.vod_id}?t=${Math.max(0, Math.round(m.sec || 0))}` : null; const inner = `“${esc(m.text)}”${m.aimed_at ? ` <span class="muted">at ${esc(m.aimed_at)}</span>` : ''}<span class="recap-mic-q">${m.quality}/10</span>`; return href ? `<a class="recap-mic" ${go(href)}><i class="fa-solid fa-play"></i> ${inner}</a>` : `<div class="recap-mic">${inner}</div>`; };
        const moment = (w.moment || r.mic.length) ? `<div class="recap-card recap-moment"><h3><i class="fa-solid fa-fire"></i> Moment of the night</h3>${w.moment ? `<p class="recap-moment-text">${esc(w.moment)}</p>` : ''}${r.mic.length ? `<div class="recap-mics">${r.mic.map(micLine).join('')}</div>` : ''}</div>` : '';
        const clips = r.clips.length ? `<div class="recap-section"><h3><i class="fa-solid fa-scissors"></i> Clips from this stream</h3><div class="recap-clips">${r.clips.map(c => `<a class="recap-clip" ${go(`/clip/${c.id}`)}>${c.thumbnail_url ? `<img src="${esc(c.thumbnail_url)}" alt="" loading="lazy">` : '<span class="recap-clip-ph"><i class="fa-solid fa-scissors"></i></span>'}<span class="recap-clip-dur">${dur(c.duration_seconds)}</span><span class="recap-clip-title">${esc(c.title)}</span>${c.view_count ? `<span class="recap-clip-views"><i class="fa-solid fa-eye"></i> ${n(c.view_count)}</span>` : ''}</a>`).join('')}</div></div>` : '';
        const vod = r.vod ? `<a class="recap-vod" ${go(`/vod/${r.vod.id}`)}>${r.vod.thumbnail_url ? `<img src="${esc(r.vod.thumbnail_url)}" alt="" loading="lazy">` : ''}<span class="recap-vod-body"><b><i class="fa-solid fa-play"></i> Watch the VOD</b><span>${dur(r.vod.duration_seconds)} · the whole stream, with the transcript and AI moments</span></span></a>` : '';
        const more = (data.more || []).length ? `<div class="recap-section"><h3><i class="fa-solid fa-clock-rotate-left"></i> More nights from ${esc(u.display_name)}</h3><div class="recap-more">${data.more.map(m => `<a class="recap-more-item" ${go(`/recap/${m.stream_id}`)}><span class="recap-grade-mini" style="--g:${(GRADE[m.grade] || GRADE.B).color}">${esc(m.grade)}</span><span class="recap-more-title">${esc(m.headline || m.title)}</span><span class="recap-more-meta">${esc(timeAgo(m.ended_at))} · ${dur(m.duration_seconds)} · peak ${n(m.peak_viewers)}</span></a>`).join('')}</div></div>` : '';
        const shareUrl = `${location.origin}/recap/${id}`;
        const shareText = `${w.headline || s.title} — ${u.display_name}'s stream report on OpenVibe.Live`;
        root.innerHTML = `
            <article class="recap" style="--g:${g.color}">
                <header class="recap-head">
                    <div class="recap-grade" title="${esc(g.label)}"><span>${esc(w.grade || 'B')}</span><small>${esc(g.label)}</small></div>
                    <div class="recap-head-body">
                        <div class="recap-kicker"><i class="fa-solid fa-clipboard-list"></i> After-show report ${r.ai ? '<span class="recap-ai"><i class="fa-solid fa-wand-magic-sparkles"></i> written by OpenVibe AI</span>' : ''}</div>
                        <h1 class="recap-headline">${esc(w.headline || s.title)}</h1>
                        <div class="recap-by">${av(u, 34)}<a class="recap-by-name" ${go(path)}>${esc(u.display_name)}</a><span class="muted">streamed</span><b>${esc(s.title)}</b><span class="recap-by-meta">${esc(when(s.started_at))} · ${dur(s.duration_seconds)}${s.category ? ` · ${esc(s.category)}` : ''}</span></div>
                        ${(w.tags || []).length ? `<div class="recap-tags">${w.tags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
                    </div>
                </header>
                ${w.summary ? `<p class="recap-summary">${esc(w.summary)}</p>` : ''}
                <div class="recap-tiles">${tiles}</div>
                ${r.viewers.curve.length >= 2 ? `<div class="recap-card recap-curve-card"><h3><i class="fa-solid fa-chart-area"></i> The room, minute by minute <span class="recap-legend"><i class="l1"></i> viewers <i class="l2"></i> chat</span></h3>${curveSvg(r.viewers.curve, s.started_at)}</div>` : ''}
                <div class="recap-cols">${moment}${chatters}</div>
                ${clips}
                ${vod}
                <div class="recap-share">
                    <button type="button" class="btn btn-primary" id="recap-copy"><i class="fa-solid fa-link"></i> Copy link</button>
                    <a class="btn btn-outline" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}"><i class="fa-brands fa-x-twitter"></i> Post</a>
                    <a class="btn btn-outline" ${go(path)}><i class="fa-solid fa-user"></i> ${esc(u.display_name)}'s channel</a>
                    ${owner ? `<button type="button" class="btn btn-outline" id="recap-regen"><i class="fa-solid fa-rotate"></i> Rewrite report</button>` : ''}
                </div>
                ${more}
            </article>`;
        const copy = root.querySelector('#recap-copy');
        if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(shareUrl); copy.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(() => { copy.innerHTML = '<i class="fa-solid fa-link"></i> Copy link'; }, 1800); } catch { prompt('Copy this link', shareUrl); } };
        const regen = root.querySelector('#recap-regen');
        if (regen) regen.onclick = async () => { regen.disabled = true; regen.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Rewriting…'; try { await api(`/recap/${id}/regenerate`, { method: 'POST' }); await loadRecapPage(id); } catch (e) { regen.disabled = false; regen.innerHTML = '<i class="fa-solid fa-rotate"></i> Rewrite report'; } };
        try { document.title = `${w.headline || s.title} — ${u.display_name}'s stream report | OpenVibe.Live`; } catch { /* */ }
    }

    window.loadRecapPage = async function (id) {
        const root = document.getElementById('recap-root');
        if (!root) return;
        root.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        let data = null;
        try { data = await api(`/recap/${encodeURIComponent(id)}`); } catch (e) {
            const live = e && /live/i.test(e.message || '');
            root.innerHTML = `<div class="empty-state"><i class="fa-solid ${live ? 'fa-tower-broadcast' : 'fa-clipboard-list'} fa-3x"></i><p>${live ? 'This stream is still live — the report lands a couple of minutes after it ends.' : 'No report for this stream.'}</p><p class="muted">${esc((e && e.message) || '')}</p><a class="btn btn-outline" ${go('/')}>Back home</a></div>`;
            return;
        }
        if (!data || !data.recap) { root.innerHTML = '<div class="empty-state"><p>No report for this stream.</p></div>'; return; }
        render(root, data, id);
    };
})();
