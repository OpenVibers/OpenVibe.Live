/*
   OpenVibe.Live — a channel's social links (server/social/): brand-coloured pills on the offline screen, rich cards in
   About (live status, latest posts or videos, repositories, page previews, loaded when they scroll into view), and the
   editor in About's edit mode. Links come from GET /api/streams/channel/:username (social_links); previews from
   /api/social/preview/:username/:index.
*/
(function () {
    'use strict';
    const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ago = (iso) => {
        const t = Date.parse(iso || ''); if (!t) return '';
        const s = Math.max(1, Math.round((Date.now() - t) / 1000));
        for (const [n, u] of [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
        return 'just now';
    };
    const label = (l) => l.label || (l.handle ? (['x', 'tiktok', 'threads', 'instagram', 'twitch', 'kick', 'github', 'bluesky', 'mastodon'].includes(l.kind) && !String(l.handle).startsWith('@') ? `@${l.handle}` : l.handle) : (l.kind === 'website' || l.kind === 'custom' ? l.url.replace(/^https:\/\/(www\.)?/, '') : l.name));

    /** Pills: one line of links (the offline screen). */
    function pills(host, links) {
        if (!host) return;
        host.innerHTML = (links || []).map((l) => `<a class="ch-social-pill" style="--sc:${escH(l.color)}" href="${escH(l.url)}" target="_blank" rel="noopener me" title="${escH(l.name)}${l.auto ? ' (connected)' : ''}"><i class="${escH(l.icon)}" aria-hidden="true"></i><span>${escH(label(l))}</span></a>`).join('');
        host.hidden = !(links || []).length;
    }

    /** Rich cards (About): the card is a link at once; its preview fills in when it scrolls into view. */
    function cards(host, links, username) {
        if (!host) return;
        if (!(links || []).length) { host.innerHTML = ''; host.hidden = true; return; }
        host.hidden = false;
        host.innerHTML = `<div class="ch-socials-head"><i class="fa-solid fa-link"></i> Links</div><div class="ch-socials-grid">${links.map((l, i) => `
            <article class="ch-social-card" style="--sc:${escH(l.color)}" data-i="${i}">
                <a class="ch-social-card-top" href="${escH(l.url)}" target="_blank" rel="noopener me">
                    <span class="ch-social-ico"><i class="${escH(l.icon)}" aria-hidden="true"></i></span>
                    <span class="ch-social-id"><b>${escH(l.name)}</b><small>${escH(label(l))}</small></span>
                    <span class="ch-social-live" hidden>LIVE</span>
                    <i class="fa-solid fa-arrow-up-right-from-square ch-social-out" aria-hidden="true"></i>
                </a>
                <div class="ch-social-body"></div>
            </article>`).join('')}</div>`;
        const load = (card) => {
            if (card.dataset.loaded) return;
            card.dataset.loaded = '1';
            const i = card.dataset.i;
            fetch(`/api/social/preview/${encodeURIComponent(username)}/${i}`, { headers: { Accept: 'application/json' } })
                .then((r) => (r.ok ? r.json() : null)).then((p) => fill(card, links[i], p)).catch(() => {});
        };
        const all = host.querySelectorAll('.ch-social-card');
        if (host._ovIo) host._ovIo.disconnect();   // one observer per host: a re-render replaces it
        if ('IntersectionObserver' in window) {
            const io = host._ovIo = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); load(e.target); } }, { rootMargin: '300px' });
            all.forEach((c) => io.observe(c));
        } else all.forEach(load);
    }

    function fill(card, link, p) {
        if (!p || p.error || p.disabled) return;
        const body = card.querySelector('.ch-social-body');
        const bits = [];
        if (p.live && p.live.live) {
            card.querySelector('.ch-social-live').hidden = false;
            card.classList.add('is-live');
            if (p.live.thumbnail) bits.push(`<a class="ch-social-livethumb" href="${escH(link.url)}" target="_blank" rel="noopener"><img src="${escH(p.live.thumbnail)}" alt="" loading="lazy">${p.live.viewers != null ? `<span><i class="fa-solid fa-eye"></i> ${escH(Number(p.live.viewers).toLocaleString())}</span>` : ''}</a>`);
            if (p.live.title) bits.push(`<p class="ch-social-livetitle">${escH(p.live.title)}</p>`);
        }
        if (p.title || p.subtitle) {
            bits.push(`<div class="ch-social-meta">${p.image && !(p.live && p.live.live) ? `<img class="ch-social-avatar" src="${escH(p.image)}" alt="" loading="lazy">` : ''}<div>${p.title ? `<b>${escH(p.title)}</b>` : ''}${p.subtitle ? `<small>${escH(p.subtitle)}</small>` : ''}</div></div>`);
        }
        if ((p.items || []).length) {
            bits.push(`<ul class="ch-social-items">${p.items.slice(0, 3).map((it) => `<li><a href="${escH(it.url || link.url)}" target="_blank" rel="noopener">${it.image ? `<img src="${escH(it.image)}" alt="" loading="lazy">` : ''}<span>${escH(it.text || '')}${it.at ? `<time>${escH(ago(it.at))}</time>` : ''}</span></a></li>`).join('')}</ul>`);
        }
        if (p.embed) bits.push(`<button type="button" class="btn btn-sm btn-outline ch-social-embed-btn"><i class="fa-brands fa-x-twitter"></i> Show recent posts</button>`);
        body.innerHTML = bits.join('');
        const btn = body.querySelector('.ch-social-embed-btn');
        if (btn) btn.addEventListener('click', () => {
            const f = document.createElement('iframe');
            f.className = 'ch-social-embed';
            f.src = p.embed; f.loading = 'lazy'; f.title = `Posts by ${label(link)} on X`;
            // No allow-same-origin: the frame is served from this origin, so that flag would hand X's script our
            // cookies, storage and DOM. Scripts and popups are all the public timeline needs.
            f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
            btn.replaceWith(f);
        });
    }

    // ── Editor (About → edit) ─────────────────────────────
    let _state = null;   // { links: [{ kind, url, label, preview }], hidden_auto: [], connected: [], missing: [] }
    let _catalog = null;
    let _onDirty = () => {};

    function editorState(ch) {
        const saved = (ch.social_links || []).filter((l) => !l.auto).map((l) => ({ kind: l.kind, url: l.url, label: l.label || '', preview: l.preview !== false }));
        const ed = ch.social_links_editor || {};
        _state = { links: saved, hidden_auto: (ed.hidden_auto || []).slice(), connected: ed.connected || [], missing: ed.restreams_without_link || [] };
        return _state;
    }

    async function editor(host, ch, onDirty) {
        if (!host) return;
        _onDirty = onDirty || (() => {});
        if (!_state) editorState(ch);
        if (!_catalog) { try { _catalog = (await (await fetch('/api/social/catalog')).json()).platforms; } catch { _catalog = []; } }
        const opts = (sel) => _catalog.map((p) => `<option value="${escH(p.kind)}"${p.kind === sel ? ' selected' : ''}>${escH(p.name)}</option>`).join('');
        const s = _state;
        host.innerHTML = `
            <label class="ch-edit-label"><i class="fa-solid fa-link"></i> Social links</label>
            ${s.connected.length ? `<div class="ch-social-connected">${s.connected.map((c) => `
                <label class="ch-social-conn" style="--sc:${escH(c.color)}"><input type="checkbox" data-auto="${escH(c.kind)}" ${s.hidden_auto.includes(c.kind) ? '' : 'checked'}>
                <i class="${escH(c.icon)}"></i> Show your connected ${escH(c.name)} (${escH(label(c))})</label>`).join('')}</div>` : ''}
            ${s.missing.length ? `<p class="muted ch-social-hint">You restream to ${s.missing.map((k) => escH((_catalog.find((p) => p.kind === k) || {}).name || k)).join(', ')}: add ${s.missing.length === 1 ? 'that channel' : 'those channels'} below so viewers can find you there.</p>` : ''}
            <div class="ch-social-rows">${s.links.map((l, i) => `
                <div class="ch-social-row" data-i="${i}">
                    <select data-f="kind" aria-label="Platform">${opts(l.kind)}</select>
                    <input data-f="url" value="${escH(l.url)}" placeholder="Profile URL or @handle" maxlength="300" aria-label="Link">
                    <input data-f="label" value="${escH(l.label)}" placeholder="Label (optional)" maxlength="40" aria-label="Label">
                    <label class="ch-social-prev" title="Show a live preview (posts, videos, live status)"><input type="checkbox" data-f="preview" ${l.preview ? 'checked' : ''}> Preview</label>
                    <button type="button" class="btn btn-sm btn-outline" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="btn btn-sm btn-outline" data-act="del" title="Remove"><i class="fa-solid fa-trash"></i></button>
                </div>`).join('')}</div>
            <button type="button" class="btn btn-sm btn-outline" data-act="add" ${s.links.length >= 16 ? 'disabled' : ''}><i class="fa-solid fa-plus"></i> Add a link</button>`;
        host.onchange = host.oninput = (e) => {
            const t = e.target;
            if (t.dataset.auto) { const k = t.dataset.auto; s.hidden_auto = t.checked ? s.hidden_auto.filter((x) => x !== k) : [...new Set([...s.hidden_auto, k])]; _onDirty(); return; }
            const row = t.closest('.ch-social-row'); if (!row) return;
            const l = s.links[Number(row.dataset.i)]; const f = t.dataset.f;
            if (!l || !f) return;
            l[f] = t.type === 'checkbox' ? t.checked : t.value;
            if (f === 'url' && /^https?:\/\//i.test(t.value)) {
                // Pick the platform from a pasted URL.
                try { const host2 = new URL(t.value).hostname.replace(/^www\./, ''); const hit = _catalog.find((p) => ({ 'x.com': 'x', 'twitter.com': 'x', 'bsky.app': 'bluesky', 'youtu.be': 'youtube' }[host2] || host2.split('.')[0]) === p.kind); if (hit && hit.kind !== l.kind) { l.kind = hit.kind; row.querySelector('select').value = hit.kind; } } catch { /* typing */ }
            }
            _onDirty();
        };
        host.onclick = (e) => {
            const b = e.target.closest('button[data-act]'); if (!b) return;
            const act = b.dataset.act; const row = b.closest('.ch-social-row'); const i = row ? Number(row.dataset.i) : -1;
            if (act === 'add') s.links.push({ kind: 'custom', url: '', label: '', preview: true });
            if (act === 'del') s.links.splice(i, 1);
            if (act === 'up' && i > 0) { const [m] = s.links.splice(i, 1); s.links.splice(i - 1, 0, m); }
            _onDirty();
            editor(host, ch, _onDirty);
        };
    }

    /** What About's save sends. */
    function payload() {
        if (!_state) return undefined;
        return { links: _state.links.filter((l) => String(l.url || '').trim()), hidden_auto: _state.hidden_auto };
    }
    function reset() { _state = null; }

    window.ChannelSocials = { pills, cards, editor, payload, reset };
})();
