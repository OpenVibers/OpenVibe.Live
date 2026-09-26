/**
 * The /search page (fragment search.html): Live's channels, VODs and clips through OpenVibe.Search
 * (GET /api/search, server/search/routes.js). The query lives in the URL (?q=&type=), so a search can
 * be linked and Back works. Results are built as DOM nodes; a snippet keeps Search's <mark> and
 * nothing else. The first page's category and channel facets (with counts) narrow the results
 * (?category=&channel=); a new query starts without them. The box suggests titles as you type
 * (GET /api/search/suggest; a combobox: arrows, Enter opens, Escape closes).
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
        const one = (k) => (sp.get(k) || '').trim().slice(0, 64);
        return { q: (sp.get('q') || '').trim().slice(0, 200), type, category: one('category'), channel: one('channel') };
    }

    // ── Facets ──
    function renderFacets(root, state, facets) {
        const box = root.querySelector('.ls-facets');
        let any = false;
        for (const group of box.querySelectorAll('.ls-facet')) {
            const key = group.dataset.lsFacet;
            const rows = ((facets && facets[key]) || []).slice();
            if (state[key] && !rows.some((r) => r.value === state[key])) rows.unshift({ value: state[key], count: null });
            group.replaceChildren();
            if (!rows.length || (rows.length === 1 && !state[key])) continue;   // one value narrows nothing
            any = true;
            group.append(el('span', 'ls-facet-label', key === 'category' ? 'Category:' : 'Channel:'));
            for (const r of rows) {
                const b = el('button');
                b.type = 'button';
                b.textContent = key === 'channel' ? `@${r.value}` : r.value;
                if (r.count != null) b.append(el('span', 'ls-count', String(r.count)));
                const on = state[key] === r.value;
                b.setAttribute('aria-pressed', String(on));
                b.addEventListener('click', () => {
                    const next = { ...readUrl(), [key]: on ? '' : r.value };
                    setUrl(next);
                    run(root, next);
                });
                group.append(b);
            }
        }
        box.hidden = !any;
    }

    async function run(root, state, cursor) {
        const { q, type } = state;
        const status = root.querySelector('.ls-status');
        const list = root.querySelector('.ls-results');
        const more = root.querySelector('.ls-more');
        const mine = ++seq;
        if (!cursor) list.replaceChildren();
        more.hidden = true;
        if (!q) { status.textContent = 'Type a streamer, a game or something said on stream.'; renderFacets(root, {}, null); return; }
        status.textContent = 'Searching…';
        const params = new URLSearchParams({ q });
        if (type) params.set('type', type);
        if (state.category) params.set('category', state.category);
        if (state.channel) params.set('channel', state.channel);
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
        if (!cursor) renderFacets(root, state, out.facets);
        for (const r of out.results || []) list.append(hit(r));
        const n = list.children.length;
        status.textContent = n ? `${n}${out.next_cursor ? '+' : ''} result${n === 1 ? '' : 's'} for “${q}”` : `Nothing public matches “${q}”.`;
        if (out.next_cursor) { more.hidden = false; more.onclick = () => run(root, state, out.next_cursor); }
    }

    function setUrl(state) {
        const sp = new URLSearchParams();
        if (state.q) sp.set('q', state.q);
        if (state.type) sp.set('type', state.type);
        if (state.category) sp.set('category', state.category);
        if (state.channel) sp.set('channel', state.channel);
        const url = `/search${sp.toString() ? `?${sp}` : ''}`;
        if (url !== location.pathname + location.search) history.pushState({}, '', url);
    }

    // ── Suggestions as you type ──
    function bindSuggest(root, input) {
        const list = root.querySelector('.ls-suggest');
        let items = [], active = -1, timer = null, asked = 0;
        const close = () => { list.hidden = true; list.replaceChildren(); items = []; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
        const open = (s) => {
            const href = localPath(s.canonical_url);
            close();
            if (href.startsWith('/') && typeof navigate === 'function') navigate(href);
            else location.href = href;
        };
        const mark = (i) => {
            active = i;
            items.forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
            if (i >= 0) { input.setAttribute('aria-activedescendant', items[i].id); items[i].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
        };
        async function ask() {
            const q = input.value.trim();
            const mine = ++asked;
            if (q.length < 2) return close();
            const params = new URLSearchParams({ q });
            const type = readUrl().type;
            if (type) params.set('type', type);
            let out = null;
            try { out = await (await fetch(`/api/search/suggest?${params}`, { headers: { accept: 'application/json' } })).json(); } catch { out = null; }
            if (mine !== asked || document.activeElement !== input) return;
            const sugg = (out && out.suggestions) || [];
            if (!sugg.length) return close();
            list.replaceChildren();
            items = sugg.map((sg, n) => {
                const li = el('li');
                li.id = `ls-sug-${n}`;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', 'false');
                const [, label] = KIND[sg.type] || ['', sg.type];
                li.append(el('span', 'ls-kind', label), el('span', null, sg.title));
                li.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box
                li.addEventListener('click', () => open(sg));
                li._s = sg;
                list.append(li);
                return li;
            });
            active = -1;
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
        }
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(ask, 150); });
        input.addEventListener('keydown', (e) => {
            if (list.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); mark(Math.min(items.length - 1, active + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); mark(Math.max(-1, active - 1)); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); open(items[active]._s); }
        });
        input.addEventListener('blur', () => setTimeout(close, 100));
        return close;
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
            const closeSuggest = bindSuggest(root, input);
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                closeSuggest();
                // A new query starts without the previous one's category and channel.
                const next = { q: input.value.trim().slice(0, 200), type: readUrl().type, category: '', channel: '' };
                setUrl(next);
                run(root, next);
            });
            for (const b of root.querySelectorAll('.ls-type')) {
                b.addEventListener('click', () => {
                    const next = { ...readUrl(), q: input.value.trim().slice(0, 200), type: b.dataset.lsType };
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
