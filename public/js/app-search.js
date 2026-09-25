/**
 * The /search page (fragment search.html): Live's channels, VODs and clips through OpenVibe.Search
 * (GET /api/search, server/search/routes.js). The query lives in the URL (?q=&type=), so a search can
 * be linked and Back works. Results are built as DOM nodes; a snippet keeps Search's <mark> and
 * nothing else.
 */
(function () {
    'use strict';
    const KIND = { channel: ['fa-tower-broadcast', 'Channel'], vod: ['fa-film', 'VOD'], clip: ['fa-scissors', 'Clip'] };
    let seq = 0;

    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    // Only text and <mark> survive: Search escapes the text and adds <mark>, but nothing else is trusted.
    function snippetNode(html, fallback) {
        const p = el('p', 'ls-snippet');
        if (!html) { p.textContent = fallback || ''; return p; }
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        for (const n of doc.body.childNodes) {
            if (n.nodeType === 3) p.append(n.textContent);
            else if (n.nodeName === 'MARK') p.append(el('mark', null, n.textContent));
            else p.append(n.textContent || '');
        }
        return p;
    }

    function localPath(url) {
        try { const u = new URL(url); return u.origin === location.origin || u.hostname === 'openvibe.live' ? u.pathname + u.search : url; } catch { return '#'; }
    }

    function hit(r) {
        const li = el('li', 'ls-hit');
        const href = localPath(r.canonical_url);
        const a = el('a', 'ls-title', r.title || 'Untitled');
        a.href = href;
        if (href.startsWith('/')) a.addEventListener('click', (e) => { if (typeof handleLinkClick === 'function') handleLinkClick(e, href); });
        const meta = el('div', 'ls-meta');
        const [icon, label] = KIND[r.type] || ['fa-circle', r.type];
        const kind = el('span', 'ls-kind');
        const i = el('i', `fa-solid ${icon}`); i.setAttribute('aria-hidden', 'true');
        kind.append(i, ` ${label}`);
        meta.append(kind);
        const f = r.facets || {};
        if (r.type === 'channel' && f.live) meta.append(el('span', 'ls-live', 'LIVE'));
        if (r.type !== 'channel' && f.channel) meta.append(el('span', null, `@${f.channel}`));
        if (f.category) meta.append(el('span', null, f.category));
        if (r.type === 'channel' && Number.isFinite(f.followers)) meta.append(el('span', null, `${f.followers} follower${f.followers === 1 ? '' : 's'}`));
        if (r.authorship === 'ai_generated') meta.append(el('span', 'ls-kind', 'AI clip'));
        li.append(a, meta, snippetNode(r.snippet_html, r.summary));
        return li;
    }

    function readUrl() {
        const sp = new URLSearchParams(location.search);
        const type = ['channel', 'vod', 'clip'].includes(sp.get('type')) ? sp.get('type') : '';
        return { q: (sp.get('q') || '').trim().slice(0, 200), type };
    }

    async function run(root, { q, type }, cursor) {
        const status = root.querySelector('.ls-status');
        const list = root.querySelector('.ls-results');
        const more = root.querySelector('.ls-more');
        const mine = ++seq;
        if (!cursor) list.replaceChildren();
        more.hidden = true;
        if (!q) { status.textContent = 'Type a streamer, a game or something said on stream.'; return; }
        status.textContent = 'Searching…';
        const params = new URLSearchParams({ q });
        if (type) params.set('type', type);
        if (cursor) params.set('cursor', cursor);
        let out;
        try {
            const res = await fetch(`/api/search?${params}`, { headers: { accept: 'application/json' } });
            out = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(out.error || 'Search is not answering right now');
        } catch (err) {
            if (mine === seq) status.textContent = `${err.message}. Try again in a minute.`;
            return;
        }
        if (mine !== seq) return;
        for (const r of out.results || []) list.append(hit(r));
        const n = list.children.length;
        status.textContent = n ? `${n}${out.next_cursor ? '+' : ''} result${n === 1 ? '' : 's'} for “${q}”` : `Nothing public matches “${q}”.`;
        if (out.next_cursor) { more.hidden = false; more.onclick = () => run(root, { q, type }, out.next_cursor); }
    }

    function setUrl(state) {
        const sp = new URLSearchParams();
        if (state.q) sp.set('q', state.q);
        if (state.type) sp.set('type', state.type);
        const url = `/search${sp.toString() ? `?${sp}` : ''}`;
        if (url !== location.pathname + location.search) history.pushState({}, '', url);
    }

    window.loadSearchPage = function loadSearchPage() {
        const root = document.querySelector('#page-search .ls-wrap');
        if (!root) return;
        const state = readUrl();
        const form = root.querySelector('.ls-form');
        const input = form.querySelector('input[name="q"]');
        input.value = state.q;
        for (const b of root.querySelectorAll('.ls-type')) b.setAttribute('aria-pressed', String(b.dataset.lsType === state.type));
        if (!form.dataset.bound) {
            form.dataset.bound = '1';
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const next = { q: input.value.trim().slice(0, 200), type: readUrl().type };
                setUrl(next);
                run(root, next);
            });
            for (const b of root.querySelectorAll('.ls-type')) {
                b.addEventListener('click', () => {
                    const next = { q: input.value.trim().slice(0, 200), type: b.dataset.lsType };
                    for (const o of root.querySelectorAll('.ls-type')) o.setAttribute('aria-pressed', String(o === b));
                    setUrl(next);
                    run(root, next);
                });
            }
        }
        if (typeof setPageTitle === 'function') setPageTitle(state.q ? `Search: ${state.q}` : 'Search');
        else document.title = `${state.q ? `Search: ${state.q}` : 'Search'} — OpenVibe.Live`;
        run(root, state);
        if (!state.q) input.focus();
    };
})();
