/* OpenVibe.Live — the Content and Moments feeds.
 *
 *   /content   what people made: VODs, clips people cut, pastes       loadContentPage({ type })
 *   /moments   what the AI made: auto-clips, AI moments, AI recaps     loadMomentsPage()
 *   /vods /clips /pastes are /content with that filter (the address becomes /content?type=…).
 *
 * The server merges the sources and pages them with a cursor (server/content/feed.js); this file
 * only renders. Cards are built as DOM nodes, never from HTML strings, so nothing a title or a
 * paste contains can become markup.
 *
 * Layout: one column of large cards on a phone; two or three columns on wider screens, each new
 * card going to the shortest column (a masonry that never reflows what is already on screen).
 * Scrolling near the end loads the next page. Clips play muted, one at a time, when mostly in view;
 * a tap turns the sound on, the title or the corner button opens the clip.
 * Everything the page starts is released through the route scope (ov.scope()) when it is left.
 */
(function () {
    'use strict';

    const FEEDS = {
        content: {
            page: 'page-content', path: '/content', api: '/api/content/feed',
            types: ['all', 'vods', 'clips', 'pastes'],
            titles: { all: 'Content', vods: 'VODs', clips: 'Clips', pastes: 'Pastes' },
            empty: {
                all: ['fa-photo-film', 'Nothing here yet', 'Streams, clips and pastes people share show up here.'],
                vods: ['fa-video', 'No videos yet', 'Streams are recorded automatically when streamers go live.'],
                clips: ['fa-scissors', 'No clips yet', 'Viewers clip the best moments of a stream with the clip button.'],
                pastes: ['fa-paste', 'No pastes yet', 'Share code, notes or a screenshot and it shows up here.'],
            },
        },
        moments: {
            page: 'page-moments', path: '/moments', api: '/api/content/moments',
            types: ['all', 'clips', 'shots', 'recaps'],
            titles: { all: 'AI Moments', clips: 'AI auto-clips', shots: 'AI moments', recaps: 'AI recaps' },
            empty: {
                all: ['fa-wand-magic-sparkles', 'No AI moments yet', 'The AI clips standout moments and writes recaps after streams.'],
                clips: ['fa-scissors', 'No auto-clips yet', 'When chat erupts during a stream, the AI cuts a clip of it.'],
                shots: ['fa-image', 'No AI moments yet', 'The AI picks standout frames from recent streams.'],
                recaps: ['fa-clipboard-list', 'No AI recaps yet', 'After a long enough stream the AI writes a recap.'],
            },
        },
    };
    const WINDOWS = ['week', 'month', 'all'];
    const PAGE = 12;

    let S = null;           // the feed on screen
    let soundOn = false;    // a person turned the sound on: later clips play with sound too

    // ── small DOM helpers ──────────────────────────────────────────────────────────────────
    function el(tag, attrs, ...kids) {
        const n = document.createElement(tag);
        if (attrs) for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k === 'dataset') Object.assign(n.dataset, v);
            else n.setAttribute(k, v === true ? '' : String(v));
        }
        for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
        return n;
    }
    const icon = (name, cls) => el('i', { class: `fa-solid ${name}${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' });
    const spa = (href, attrs, ...kids) => el('a', { href, 'data-spa': '1', ...attrs }, ...kids);

    function compact(n) {
        const v = Math.max(0, Number(n) || 0);
        if (v >= 999500) return `${(v / 1e6).toFixed(v >= 9999500 ? 0 : 1).replace(/\.0$/, '')}M`;
        if (v >= 999.5) return `${(v / 1e3).toFixed(v >= 9999.5 ? 0 : 1).replace(/\.0$/, '')}K`;
        return String(v);
    }
    function duration(sec) {
        sec = Math.max(0, Math.round(Number(sec) || 0));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    }
    const ago = (iso) => (typeof timeAgo === 'function' ? timeAgo(iso) : '');
    function avatar(p) {
        const letter = (String((p && (p.display_name || p.username)) || '?')[0] || '?').toUpperCase();
        const box = el('span', { class: 'cf-av', 'aria-hidden': 'true' });
        if (p && p.profile_color && /^#[0-9a-f]{3,8}$/i.test(p.profile_color)) box.style.background = p.profile_color;
        if (p && p.avatar_url) {
            const img = el('img', { src: p.avatar_url, alt: '', loading: 'lazy', decoding: 'async' });
            img.addEventListener('error', () => { img.remove(); box.textContent = letter; }, { once: true });
            box.append(img);
        } else box.textContent = letter;
        return box;
    }
    function thumb(url, fallbackIcon) {
        if (!url) return el('span', { class: 'cf-thumb cf-thumb--ph' }, icon(fallbackIcon));
        const img = el('img', { class: 'cf-thumb', src: url, alt: '', loading: 'lazy', decoding: 'async' });
        img.addEventListener('error', () => img.replaceWith(el('span', { class: 'cf-thumb cf-thumb--ph' }, icon(fallbackIcon))), { once: true });
        return img;
    }
    const aiBadge = () => el('span', { class: 'cf-ai', title: 'Made by AI' }, icon('fa-wand-magic-sparkles'), 'AI');

    // ── cards ──────────────────────────────────────────────────────────────────────────────
    function meta(it, extra) {
        const row = el('div', { class: 'cf-meta' });
        if (it.channel) {
            const who = [avatar(it.channel), el('span', { class: 'cf-name', text: it.channel.display_name || it.channel.username })];
            row.append(it.channel.href ? spa(it.channel.href, { class: 'cf-chan' }, ...who) : el('span', { class: 'cf-chan' }, ...who));
        }
        const bits = el('span', { class: 'cf-facts' });
        if (it.ai_label) bits.append(el('span', { class: 'cf-ailabel', text: it.ai_label }));
        if (it.created_at) bits.append(el('time', { datetime: it.created_at, title: new Date(it.created_at).toLocaleString(), text: ago(it.created_at) }));
        if (it.kind === 'recap') { if (it.views) bits.append(el('span', { text: `peak ${compact(it.views)} watching` })); }
        else bits.append(el('span', { text: `${compact(it.views)} view${it.views === 1 ? '' : 's'}` }));
        if (it.kind === 'paste' && it.likes) bits.append(el('span', { class: 'cf-likes' }, icon('fa-heart'), ` ${compact(it.likes)}`));
        if (extra) bits.append(extra);
        row.append(bits);
        return row;
    }

    function vodCard(it) {
        const media = spa(it.href, { class: 'cf-media', 'aria-label': `Watch ${it.title}` },
            thumb(it.thumbnail_url, 'fa-video'),
            el('span', { class: 'cf-kind' }, icon('fa-video'), 'VOD'),
            el('span', { class: 'cf-pill cf-dur', text: duration(it.duration_seconds) }),
            el('span', { class: 'cf-play', 'aria-hidden': 'true' }, icon('fa-play')));
        const body = el('div', { class: 'cf-body' }, spa(it.href, { class: 'cf-title', text: it.title }), meta(it));
        if (it.excerpt) body.append(el('p', { class: 'cf-excerpt', text: it.excerpt }));
        return el('article', { class: 'cf-card cf-card--vod' }, media, body);
    }

    function clipCard(it) {
        const playable = !!(it.thumbnail_url && it.preview_url);
        const badge = it.ai ? aiBadge() : el('span', { class: 'cf-kind' }, icon('fa-scissors'), 'Clip');
        const dur = el('span', { class: 'cf-pill cf-dur', text: duration(it.duration_seconds) });
        let box, video = null;
        if (playable) {
            // Plays in place: a tap is for sound, the corner button and the title open the clip.
            video = el('video', { class: 'cf-video', muted: true, playsinline: true, loop: true, preload: 'none', poster: it.thumbnail_url, 'aria-label': it.title });
            video.muted = true;
            video.dataset.src = it.preview_url;
            box = el('div', { class: 'cf-media cf-media--clip' }, video, badge, dur,
                spa(it.href, { class: 'cf-open', 'aria-label': 'Open clip', title: 'Open clip' }, icon('fa-up-right-and-down-left-from-center')),
                el('button', { type: 'button', class: 'cf-sound', 'aria-label': 'Turn sound on', title: 'Sound' }, icon('fa-volume-xmark')),
                el('span', { class: 'cf-play', 'aria-hidden': 'true' }, icon('fa-play')));
        } else {
            box = spa(it.href, { class: 'cf-media', 'aria-label': `Watch ${it.title}` }, thumb(it.thumbnail_url, 'fa-scissors'), badge, dur,
                el('span', { class: 'cf-play', 'aria-hidden': 'true' }, icon('fa-play')));
        }
        const body = el('div', { class: 'cf-body' }, spa(it.href, { class: 'cf-title', text: it.title }), meta(it));
        if (it.by) body.append(el('div', { class: 'cf-by' }, icon('fa-scissors'), ' Clipped by ', it.by.href ? spa(it.by.href, { text: it.by.display_name || it.by.username }) : it.by.display_name));
        if (it.excerpt) body.append(el('p', { class: 'cf-excerpt', text: it.excerpt }));
        const card = el('article', { class: `cf-card cf-card--clip${it.ai ? ' cf-card--ai' : ''}` }, box, body);
        if (video && S) S.clips.observe(video);
        return card;
    }

    function pasteCard(it) {
        let media;
        if (it.paste_type === 'image') {
            media = spa(it.href, { class: `cf-media cf-media--image${it.nsfw ? ' cf-nsfw' : ''}`, 'aria-label': `Open ${it.title}` },
                thumb(it.image_url, 'fa-image'),
                it.ai ? aiBadge() : el('span', { class: 'cf-kind' }, icon('fa-image'), 'Image'));
            if (it.nsfw) media.append(el('span', { class: 'cf-nsfw-label', text: 'NSFW' }));
        } else {
            media = spa(it.href, { class: 'cf-code', 'aria-label': `Open ${it.title}` },
                el('pre', null, el('code', { text: it.excerpt || '' })),
                el('span', { class: 'cf-kind' }, icon('fa-code'), it.language && it.language !== 'text' ? it.language : 'Paste'));
            if (it.ai) media.append(aiBadge());
        }
        const body = el('div', { class: 'cf-body' }, spa(it.href, { class: 'cf-title', text: it.title }), meta(it));
        if (it.paste_type === 'image' && it.excerpt) body.append(el('p', { class: 'cf-excerpt', text: it.excerpt }));
        if (it.moment_href) body.append(spa(it.moment_href, { class: 'cf-moment-link' }, icon('fa-circle-play'), ' Watch this moment'));
        return el('article', { class: `cf-card cf-card--paste${it.ai ? ' cf-card--ai' : ''}` }, media, body);
    }

    function recapCard(it) {
        const media = spa(it.href, { class: 'cf-media cf-media--recap', 'aria-label': `Read the recap: ${it.title}` },
            it.thumbnail_url ? thumb(it.thumbnail_url, 'fa-clipboard-list') : el('span', { class: 'cf-thumb cf-thumb--ph' }, icon('fa-clipboard-list')),
            aiBadge());
        if (it.grade) media.append(el('span', { class: `cf-grade cf-grade--${it.grade.toLowerCase()}`, title: `Grade ${it.grade}`, text: it.grade }));
        if (it.duration_seconds) media.append(el('span', { class: 'cf-pill cf-dur', text: duration(it.duration_seconds) }));
        const body = el('div', { class: 'cf-body' }, spa(it.href, { class: 'cf-title', text: it.title }));
        if (it.stream_title && it.stream_title !== it.title) body.append(el('div', { class: 'cf-streamtitle', text: it.stream_title }));
        body.append(meta(it));
        if (it.excerpt) body.append(el('p', { class: 'cf-excerpt', text: it.excerpt }));
        return el('article', { class: 'cf-card cf-card--recap cf-card--ai' }, media, body);
    }

    const BUILD = { vod: vodCard, clip: clipCard, paste: pasteCard, recap: recapCard };

    /** Staff see the same bulk-select checkboxes as on the channel pages (app.js _selWrap). */
    function selectable(it, card) {
        if (!S.sel || !['vod', 'clip', 'paste'].includes(it.kind)) return card;
        const id = String(it.id);
        const input = el('input', { type: 'checkbox', 'aria-label': `Select ${it.title}` });
        input.checked = !!(window._sel && window._sel[it.kind] && window._sel[it.kind].has(id));
        input.addEventListener('change', () => { if (typeof _selToggle === 'function') _selToggle(it.kind, id, input.checked); });
        const label = el('label', { class: 'sel-card-check', title: 'Select' }, input);
        label.addEventListener('click', (e) => e.stopPropagation());
        return el('div', { class: 'sel-card-wrap', dataset: { selType: it.kind, selId: id } }, label, card);
    }

    // ── masonry columns ────────────────────────────────────────────────────────────────────
    function columnCount() {
        const w = S.feedEl.clientWidth || window.innerWidth;
        return w >= 1080 ? 3 : w >= 680 ? 2 : 1;
    }
    function buildColumns(n) {
        S.feedEl.replaceChildren();
        S.cols = [];
        for (let i = 0; i < n; i++) { const c = el('div', { class: 'cf-col' }); S.cols.push(c); S.feedEl.append(c); }
        S.feedEl.dataset.cols = String(n);
    }
    function shortest() {
        let best = S.cols[0], h = Infinity;
        for (const c of S.cols) { const ch = c.offsetHeight; if (ch < h - 1) { h = ch; best = c; } }
        return best;
    }
    function place(node) { shortest().append(node); }
    function relayout() {
        if (!S) return;
        const n = columnCount();
        if (n === S.cols.length) return;
        const nodes = S.cards.slice();
        buildColumns(n);
        for (const node of nodes) place(node);
    }

    // ── skeletons and footer states ────────────────────────────────────────────────────────
    function skeletons(count) {
        const out = [];
        for (let i = 0; i < count; i++) {
            const sk = el('div', { class: 'cf-card cf-skel', 'data-skeleton': '1', 'aria-hidden': 'true' },
                el('div', { class: 'cf-skel-media' }),
                el('div', { class: 'cf-skel-body' }, el('span', { class: 'cf-skel-line' }), el('span', { class: 'cf-skel-line cf-skel-line--short' })));
            out.push(sk);
            place(sk);
        }
        S.skels = out;
    }
    function clearSkeletons() { for (const sk of S.skels || []) sk.remove(); S.skels = []; }

    function foot(kind, detail) {
        const f = S.footEl;
        f.replaceChildren();
        f.dataset.state = kind || '';
        if (kind === 'empty') {
            const [ic, title, sub] = S.cfg.empty[S.type] || S.cfg.empty.all;
            f.append(el('div', { class: 'cf-empty' }, icon(ic, 'cf-empty-icon'), el('p', { class: 'cf-empty-title', text: title }), el('p', { class: 'cf-empty-sub', text: sub })));
        } else if (kind === 'error' || kind === 'partial') {
            const retry = el('button', { type: 'button', class: 'btn btn-small btn-outline' }, icon('fa-rotate-right'), ' Try again');
            retry.addEventListener('click', () => { foot(null); loadMore(true); });
            f.append(el('div', { class: `cf-note${kind === 'error' ? ' cf-note--error' : ''}` },
                el('span', { text: kind === 'error' ? (detail || 'This feed could not load.') : 'Some of this feed did not load. What loaded is shown.' }), retry));
        } else if (kind === 'end') {
            f.append(el('p', { class: 'cf-end', text: S.feed === 'moments' ? 'That is every AI moment for now.' : "You're all caught up." }));
        } else if (kind === 'more') {
            const more = el('button', { type: 'button', class: 'btn btn-small btn-outline cf-more' }, 'Load more');
            more.addEventListener('click', () => loadMore(true));
            f.append(more);
        }
    }

    // ── loading ────────────────────────────────────────────────────────────────────────────
    function queryString(withCursor) {
        const p = new URLSearchParams();
        if (S.type !== 'all') p.set('type', S.type);
        if (S.sort === 'top') { p.set('sort', 'top'); p.set('window', S.win); }
        if (withCursor) { p.set('limit', String(PAGE)); if (S.next) p.set('cursor', S.next); }
        return p.toString();
    }

    async function loadMore(retry) {
        if (!S || S.loading || ((S.done || S.halted) && !retry)) return;
        const st = S, gen = st.gen;
        st.loading = true;
        st.halted = false;
        const first = !st.cards.length;
        if (first) { if (!st.skels.length) skeletons(st.cols.length > 1 ? st.cols.length * 2 : 2); }
        else skeletons(st.cols.length);
        st.feedEl.setAttribute('aria-busy', 'true');
        let data = null, failure = null;
        try {
            const res = await fetch(`${st.cfg.api}?${queryString(true)}`, { signal: st.abort.signal, headers: { Accept: 'application/json' } });
            data = await res.json().catch(() => null);
            if (!res.ok) failure = (data && data.error) || 'This feed could not load.';
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            failure = navigator.onLine === false ? "You're offline." : 'This feed could not load.';
        }
        if (S !== st || st.gen !== gen) return;
        st.loading = false;
        clearSkeletons();
        st.feedEl.setAttribute('aria-busy', 'false');
        // Stop here until someone asks again: an observer that keeps seeing the end must not
        // turn a failing upstream into a request loop.
        if (failure || !data) { st.halted = true; foot('error', failure); return; }

        render(data.items || []);
        st.next = data.next || null;
        st.done = !st.next;
        if (data.sources) st.sources = data.sources;
        if (!st.cards.length) {
            if (data.partial) { st.halted = true; foot('error', 'This feed could not load right now.'); }
            else foot('empty');
            return;
        }
        if (data.partial) { foot('partial'); if (!(data.items || []).length) { st.halted = true; return; } }
        else if (!(data.items || []).length && !st.done) { st.halted = true; foot('more'); return; }   // never spin on empty pages
        else foot(st.done ? 'end' : ('IntersectionObserver' in window ? null : 'more'));
        // A short page (or a tall screen) can leave the end in view: keep going.
        if (!st.done && !data.partial) requestAnimationFrame(() => { if (S === st) st.watchEnd(); });
    }

    function render(items) {
        const vodGroups = S.sort === 'new';
        for (const it of items) {
            if (!it || !it.key || S.seen.has(it.key) || !BUILD[it.kind]) continue;
            S.seen.add(it.key);
            // A stream that restarted is several VODs in a row with the same title on the same day:
            // one card that says how many parts, instead of a column of copies.
            if (vodGroups && it.kind === 'vod' && S.lastVod && S.lastVod.group === vodGroup(it)) {
                S.lastVod.parts++;
                S.lastVod.seconds += Number(it.duration_seconds) || 0;
                S.lastVod.partsEl.textContent = `${S.lastVod.parts} parts`;
                S.lastVod.partsEl.hidden = false;
                S.lastVod.durEl.textContent = duration(S.lastVod.seconds);
                continue;
            }
            let card;
            try { card = BUILD[it.kind](it); } catch (err) { console.warn('[Feed] card failed', it.key, err); continue; }
            card.dataset.key = it.key;
            const node = selectable(it, card);
            S.cards.push(node);
            place(node);
            if (it.kind === 'vod') {
                const partsEl = el('span', { class: 'cf-pill cf-parts', hidden: true }, '');
                card.querySelector('.cf-media').append(partsEl);
                S.lastVod = { group: vodGroup(it), parts: 1, seconds: Number(it.duration_seconds) || 0, partsEl, durEl: card.querySelector('.cf-dur') };
            } else S.lastVod = null;
        }
    }
    const vodGroup = (it) => `${it.channel ? it.channel.username : ''}|${String(it.title || '').trim().toLowerCase()}|${String(it.created_at || '').slice(0, 10)}`;

    // ── clips: one plays at a time ─────────────────────────────────────────────────────────
    function clipController(scope) {
        const ratios = new Map();
        let active = null;
        const still = (() => {
            try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch { /* */ }
            try { if (navigator.connection && navigator.connection.saveData) return true; } catch { /* */ }
            return false;
        })();
        const media = (v) => v.closest('.cf-media');
        function setSoundIcon(v) {
            const b = media(v) && media(v).querySelector('.cf-sound');
            if (!b) return;
            b.replaceChildren(icon(v.muted ? 'fa-volume-xmark' : 'fa-volume-high'));
            b.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Turn sound off');
        }
        function start(v, withSound) {
            if (!v.dataset.src) return;
            if (active && active !== v) stop(active);
            active = v;
            if (!v.getAttribute('src')) v.src = v.dataset.src;
            v.muted = !withSound;
            media(v).classList.add('is-playing');
            setSoundIcon(v);
            const p = v.play();
            if (p && p.catch) p.catch(() => {
                // Sound without a fresh tap can be refused: fall back to silent rather than stopped.
                if (!v.muted) { v.muted = true; setSoundIcon(v); v.play().catch(() => media(v).classList.remove('is-playing')); }
                else media(v).classList.remove('is-playing');
            });
        }
        function stop(v) {
            try { v.pause(); } catch { /* */ }
            if (media(v)) media(v).classList.remove('is-playing');
            if (active === v) active = null;
        }
        function unload(v) {
            if (!v.getAttribute('src')) return;
            stop(v);
            v.removeAttribute('src');
            try { v.load(); } catch { /* */ }   // gives the decoder and its buffer back
        }
        function pick() {
            if (still) return;
            // The most visible clip; among clips equally in view, the one nearest the middle of the screen.
            let best = null, bestRatio = 0.6, bestDist = Infinity;
            const mid = window.innerHeight / 2;
            for (const [v, r] of ratios) {
                if (r < bestRatio - 0.01 || !v.isConnected) continue;
                const box = v.getBoundingClientRect();
                const dist = Math.abs(box.top + box.height / 2 - mid);
                if (r > bestRatio + 0.01 || dist < bestDist) { best = v; bestRatio = Math.max(r, 0.6); bestDist = dist; }
            }
            if (best && best !== active) start(best, soundOn);
            else if (!best && active && (ratios.get(active) || 0) < 0.35) stop(active);
            for (const [v, r] of ratios) if (r === 0 && v !== active) unload(v);
        }
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) ratios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
            pick();
        }, { threshold: [0, 0.35, 0.6, 0.8, 1] });
        scope.observe(io);
        scope.onDispose(() => { for (const v of ratios.keys()) unload(v); ratios.clear(); });
        return {
            observe(v) { ratios.set(v, 0); io.observe(v); },
            /** A tap on a clip: sound on (or off), and this clip is the one playing. */
            tap(v) {
                if (active !== v || v.paused) { soundOn = true; start(v, true); return; }
                v.muted = !v.muted;
                soundOn = !v.muted;
                setSoundIcon(v);
            },
            forget() { for (const v of ratios.keys()) { io.unobserve(v); unload(v); } ratios.clear(); },
        };
    }

    // ── controls and the address ───────────────────────────────────────────────────────────
    function syncControls() {
        const w = S.wrap;
        w.querySelectorAll('[data-cf-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cfType === S.type)));
        w.querySelectorAll('[data-cf-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cfSort === S.sort)));
        w.querySelectorAll('[data-cf-window]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cfWindow === S.win)));
        const win = w.querySelector('.cf-window');
        if (win) win.hidden = S.sort !== 'top';
        const np = w.querySelector('[data-cf-new-paste]');
        if (np) np.hidden = !(S.type === 'pastes');
        if (typeof setPageTitle === 'function') setPageTitle(S.cfg.titles[S.type] || S.cfg.titles.all);
    }
    function syncUrl() {
        const qs = queryString(false);
        const url = `${S.cfg.path}${qs ? `?${qs}` : ''}`;
        if (location.pathname + location.search !== url) history.replaceState(history.state, '', url);
    }

    function restart() {
        S.gen++;
        try { S.abort.abort(); } catch { /* */ }
        S.abort = new AbortController();
        S.clips.forget();
        S.next = null; S.done = false; S.loading = false; S.halted = false;
        S.seen = new Set(); S.cards = []; S.skels = []; S.lastVod = null;
        buildColumns(columnCount());
        foot(null);
        syncControls();
        syncUrl();
        if (S.sel && typeof _selSetContext === 'function') _selSetContext(true, () => S && restart());
        loadMore();
    }

    /** A new filter starts a new list: from its top, if the reader had scrolled past it. */
    function refilter() {
        restart();
        const top = S.wrap.querySelector('.cf-bar').getBoundingClientRect().top;
        if (top < 0 || S.wrap.getBoundingClientRect().top < 0) window.scrollTo({ top: Math.max(0, S.wrap.getBoundingClientRect().top + window.scrollY) });
    }

    function onControl(e) {
        const b = e.target.closest('button');
        if (!b || !S || !S.wrap.contains(b)) return;
        if (b.dataset.cfType && b.dataset.cfType !== S.type && S.cfg.types.includes(b.dataset.cfType)) { S.type = b.dataset.cfType; refilter(); }
        else if (b.dataset.cfSort && b.dataset.cfSort !== S.sort) { S.sort = b.dataset.cfSort === 'top' ? 'top' : 'new'; refilter(); }
        else if (b.dataset.cfWindow && b.dataset.cfWindow !== S.win && WINDOWS.includes(b.dataset.cfWindow)) { S.win = b.dataset.cfWindow; refilter(); }
        else if (b.hasAttribute('data-cf-new-paste')) {
            const go = () => { if (typeof openNewPasteModal === 'function') openNewPasteModal(); };
            if (window.ov) ov.load('pastes').then(go, () => {}); else go();
        }
    }

    function onFeedClick(e) {
        const sound = e.target.closest('.cf-sound');
        const clipBox = e.target.closest('.cf-media--clip');
        if (clipBox && (sound || !e.target.closest('a'))) {
            const v = clipBox.querySelector('video');
            if (v) { e.preventDefault(); S.clips.tap(v); }
            return;
        }
        const a = e.target.closest('a[data-spa]');
        if (a && typeof handleLinkClick === 'function') handleLinkClick(e, a.getAttribute('href'));
    }

    // ── entry ──────────────────────────────────────────────────────────────────────────────
    function open(feed, opts) {
        const cfg = FEEDS[feed];
        const section = document.getElementById(cfg.page);
        const wrap = section && section.querySelector('.cf-wrap');
        if (!wrap) return;
        const scope = window.ov ? ov.scope() : { observe: (o) => o, onDispose() {}, listen(t, n, f, o) { t.addEventListener(n, f, o); } };
        const params = new URLSearchParams(location.search);
        const want = (opts && opts.type) || params.get('type');
        S = {
            feed, cfg, wrap, scope,
            feedEl: wrap.querySelector('.cf-feed'), footEl: wrap.querySelector('.cf-foot'), sentinel: wrap.querySelector('.cf-sentinel'),
            type: cfg.types.includes(want) ? want : 'all',
            sort: params.get('sort') === 'top' ? 'top' : 'new',
            win: WINDOWS.includes(params.get('window')) ? params.get('window') : 'month',
            gen: 0, abort: new AbortController(), cols: [], cards: [], skels: [], seen: new Set(), next: null, done: false, loading: false, halted: false, lastVod: null,
            sel: typeof _isContentAdmin === 'function' && _isContentAdmin(),
        };
        const st = S;
        st.clips = clipController(scope);
        // Leaving the route: stop the fetch, the players and the observers; this state is dead.
        scope.onDispose(() => {
            try { st.abort.abort(); } catch { /* */ }
            if (st.sel && typeof _selSetContext === 'function') _selSetContext(false);
            if (S === st) S = null;
        });
        scope.listen(wrap.querySelector('.cf-bar'), 'click', onControl);
        scope.listen(st.feedEl, 'click', onFeedClick);
        scope.listen(wrap.querySelector('.cf-head'), 'click', (e) => {
            const a = e.target.closest('a[data-cf-link]');
            if (a && typeof handleLinkClick === 'function') handleLinkClick(e, a.getAttribute('href'));
        });
        let resizeRaf = 0;
        scope.listen(window, 'resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(relayout); }, { passive: true });
        if ('IntersectionObserver' in window) {
            const io = scope.observe(new IntersectionObserver((entries) => {
                if (entries.some((e) => e.isIntersecting)) loadMore();
            }, { rootMargin: '900px 0px' }));
            io.observe(st.sentinel);
            // Re-observing makes the observer report the sentinel's current state once more.
            st.watchEnd = () => { io.unobserve(st.sentinel); io.observe(st.sentinel); };
        } else st.watchEnd = () => {};
        restart();
    }

    window.loadContentPage = (opts) => open('content', opts || {});
    window.loadMomentsPage = (opts) => open('moments', opts || {});
})();
