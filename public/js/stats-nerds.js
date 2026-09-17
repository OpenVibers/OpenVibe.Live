/**
 * Stats for nerds — the "over time" view behind every hero number.
 *
 * Loaded on the first click of a hero stat (features.json: statsNerds), so the home page does not
 * pay for it. One dialog, one metric at a time, with the controls in a single row above the chart:
 *
 *   - time range presets (a day / week / month / quarter / year; the day preset only for readings)
 *   - a view: per day | running total for counters, average | peak for live readings
 *   - a table view, so no value is only reachable by hovering
 *   - ‹ › (and ← →) to walk through every metric the board has
 *
 * Counters (users, messages, VODs…) come as daily values plus `before` (everything earlier) and
 * `prev_total` (the same-length window before this one). Readings (streams live, people watching)
 * come from the five-minute sampler as per-hour or per-day averages and peaks, with null where
 * nothing was sampled — drawn as gaps, never as zero.
 *
 * Chart rules follow the dataviz method: one axis, thin marks capped at 24px with 4px rounded
 * ends on a single baseline, hairline solid grid, the accent for the data and a gray for context,
 * text in text colours, a tooltip that leads with the value, and a refetch that keeps the old
 * chart (dimmed) instead of flashing a spinner.
 */
(function () {
    'use strict';

    const ICON = {
        liveNow: 'fa-circle', viewersNow: 'fa-eye', users: 'fa-users', anons: 'fa-user-secret', visitors: 'fa-user-plus',
        active: 'fa-fire', follows: 'fa-heart', messages: 'fa-comments', sessions: 'fa-tower-broadcast',
        streamers: 'fa-satellite-dish', vods: 'fa-film', clips: 'fa-scissors', pastes: 'fa-paste', hours: 'fa-clock',
        hoursWatched: 'fa-couch', aiMoments: 'fa-brain', vibes: 'fa-hand-holding-dollar', supporters: 'fa-hand-holding-heart',
        vibesBought: 'fa-cart-shopping', subs: 'fa-star', points: 'fa-coins', pointsSpent: 'fa-gift', redemptions: 'fa-gift',
        emotes: 'fa-face-grin-squint',
    };
    const RANGES = [
        { days: 1, label: '24h', readingOnly: true },
        { days: 7, label: '7d' }, { days: 30, label: '30d' }, { days: 90, label: '90d' }, { days: 365, label: '1y' },
    ];

    const nf = new Intl.NumberFormat();
    const fmt = (v, unit = '') => {
        if (v == null || !Number.isFinite(Number(v))) return '—';
        const n = Number(v);
        const abs = Math.abs(n);
        const s = abs >= 1e6 ? (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
            : abs >= 1e4 ? (n / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K'
                : Number.isInteger(n) ? nf.format(n) : nf.format(Math.round(n * 10) / 10);
        return s + unit;
    };
    const exact = (v, unit = '') => (v == null ? '—' : nf.format(Math.round(Number(v) * 10) / 10) + unit);
    const dayLabel = (iso, opts = { month: 'short', day: 'numeric' }) => {
        try { return new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toLocaleDateString(undefined, { ...opts, timeZone: iso.length === 10 ? 'UTC' : undefined }); } catch { return iso; }
    };
    const hourLabel = (iso) => {
        try { return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }); } catch { return iso; }
    };
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    /** Clean axis: a 1/2/2.5/5 × 10^n step, whole numbers for whole-number data, ~4 intervals. */
    const niceScale = (max, integer) => {
        if (!(max > 0)) return { top: integer ? 4 : 1, step: integer ? 1 : 0.25 };
        const raw = max / 4;
        const p = Math.pow(10, Math.floor(Math.log10(raw)));
        let step = 10 * p;
        for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) { step = m * p; break; }
        if (integer && step < 1) step = 1;
        if (integer && !Number.isInteger(step)) step = Math.ceil(step);
        return { top: Math.ceil(max / step - 1e-9) * step, step };
    };

    const state = { overlay: null, metrics: [], index: 0, days: 30, view: 'daily', table: false, data: null, req: 0, lastFocus: null, ro: null };

    /** Every chartable chip on the hero, in board order, deduplicated by metric. */
    function collectMetrics() {
        const seen = new Set();
        const out = [];
        document.querySelectorAll('#hero-stats .hero-stat[data-metric]').forEach((chip) => {
            const metric = chip.dataset.metric;
            if (seen.has(metric)) return;
            seen.add(metric);
            let tip = {};
            try { tip = JSON.parse(chip.dataset.tip || '{}'); } catch { /* */ }
            const numEl = chip.querySelector('.hero-stat-num');
            out.push({ metric, label: tip.label || metric, desc: tip.desc || tip.title || '', unit: tip.recent?.unit || (metric === 'hours' || metric === 'hoursWatched' ? 'h' : ''), now: numEl ? Number(numEl.dataset.n) : null });
        });
        return out;
    }

    function open(chip) {
        state.metrics = collectMetrics();
        const metric = chip?.dataset?.metric;
        state.index = Math.max(0, state.metrics.findIndex((m) => m.metric === metric));
        if (!state.metrics.length) return;
        state.lastFocus = document.activeElement;
        const isReading = (m) => m.metric === 'liveNow' || m.metric === 'viewersNow';
        state.days = isReading(state.metrics[state.index]) ? 7 : 30;
        state.view = isReading(state.metrics[state.index]) ? 'avg' : 'daily';
        state.table = false;
        build();
        load();
    }

    function close() {
        if (!state.overlay) return;
        state.ro?.disconnect();
        document.removeEventListener('keydown', onKey, true);
        const ov = state.overlay;
        state.overlay = null;
        ov.classList.add('is-closing');
        setTimeout(() => ov.remove(), 160);
        try { state.lastFocus?.focus?.({ preventScroll: true }); } catch { /* */ }
    }

    function onKey(e) {
        if (!state.overlay) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        const inChart = e.target.closest?.('.sn-plot');
        if (!inChart && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('input, select, textarea')) {
            e.preventDefault();
            step(e.key === 'ArrowRight' ? 1 : -1);
        }
    }

    function step(dir) {
        const n = state.metrics.length;
        const prevReading = current().kind === 'reading';
        state.index = (state.index + dir + n) % n;
        const reading = state.metrics[state.index].metric === 'liveNow' || state.metrics[state.index].metric === 'viewersNow';
        if (reading !== prevReading) {
            state.view = reading ? 'avg' : 'daily';
            if (!reading && state.days === 1) state.days = 7;
        }
        renderHead();
        load();
    }

    const current = () => {
        const m = state.metrics[state.index];
        return { ...m, kind: (m.metric === 'liveNow' || m.metric === 'viewersNow') ? 'reading' : 'count' };
    };

    function build() {
        document.querySelector('.sn-overlay')?.remove();
        const ov = el('div', 'sn-overlay');
        ov.innerHTML = `
            <div class="sn-dialog" role="dialog" aria-modal="true" aria-labelledby="sn-title" tabindex="-1">
                <header class="sn-head">
                    <button type="button" class="sn-nav sn-prev" aria-label="Previous stat"><i class="fa-solid fa-chevron-left"></i></button>
                    <div class="sn-title-wrap">
                        <div class="sn-kicker"><i class="fa-solid fa-flask-vial"></i> Stats for nerds <span class="sn-pos"></span></div>
                        <h3 id="sn-title"><i class="sn-icon fa-solid"></i><span class="sn-name"></span></h3>
                        <p class="sn-desc"></p>
                    </div>
                    <button type="button" class="sn-nav sn-next" aria-label="Next stat"><i class="fa-solid fa-chevron-right"></i></button>
                    <button type="button" class="sn-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </header>
                <div class="sn-controls">
                    <div class="sn-seg sn-ranges" role="group" aria-label="Time range"></div>
                    <div class="sn-seg sn-views" role="group" aria-label="View"></div>
                    <button type="button" class="sn-table-btn" aria-pressed="false"><i class="fa-solid fa-table-list"></i><span>Table</span></button>
                </div>
                <div class="sn-tiles"></div>
                <div class="sn-body">
                    <div class="sn-plot" tabindex="0" role="img"></div>
                    <div class="sn-table" hidden></div>
                    <div class="sn-tip" role="status" aria-live="polite" hidden></div>
                </div>
                <footer class="sn-foot"><span class="sn-note"></span><span class="sn-swipe-hint">Swipe for more stats</span><button type="button" class="sn-csv"><i class="fa-solid fa-download"></i> CSV</button></footer>
            </div>`;
        document.body.appendChild(ov);
        state.overlay = ov;
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        ov.querySelector('.sn-close').addEventListener('click', close);
        ov.querySelector('.sn-prev').addEventListener('click', () => step(-1));
        ov.querySelector('.sn-next').addEventListener('click', () => step(1));
        ov.querySelector('.sn-table-btn').addEventListener('click', () => { state.table = !state.table; renderBody(); });
        ov.querySelector('.sn-csv').addEventListener('click', downloadCsv);
        document.addEventListener('keydown', onKey, true);
        // Phones have no arrows: a horizontal swipe on the header or tiles walks through the stats.
        let sx = null, sy = 0;
        const head = ov.querySelector('.sn-dialog');
        head.addEventListener('touchstart', (e) => { if (e.target.closest('.sn-plot, .sn-table')) { sx = null; return; } sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
        head.addEventListener('touchend', (e) => {
            if (sx == null) return;
            const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
            sx = null;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        }, { passive: true });
        const plot = ov.querySelector('.sn-plot');
        state.ro = new ResizeObserver(() => { if (state.data && !state.table) drawChart(); });
        state.ro.observe(plot);
        renderHead();
        ov.querySelector('.sn-dialog').focus({ preventScroll: true });
    }

    function renderHead() {
        const ov = state.overlay; if (!ov) return;
        const m = current();
        ov.querySelector('.sn-icon').className = `sn-icon fa-solid ${ICON[m.metric] || 'fa-chart-line'}`;
        ov.querySelector('.sn-name').textContent = m.label;
        ov.querySelector('.sn-desc').textContent = m.desc;
        ov.querySelector('.sn-pos').textContent = `${state.index + 1} / ${state.metrics.length}`;
        const multi = state.metrics.length > 1;
        ov.querySelectorAll('.sn-nav').forEach((b) => { b.hidden = !multi; });

        const ranges = ov.querySelector('.sn-ranges');
        ranges.replaceChildren(...RANGES.filter((r) => !r.readingOnly || m.kind === 'reading').map((r) => {
            const b = el('button', r.days === state.days ? 'is-on' : '', r.label);
            b.type = 'button';
            b.setAttribute('aria-pressed', String(r.days === state.days));
            b.addEventListener('click', () => { if (state.days !== r.days) { state.days = r.days; renderHead(); load(); } });
            return b;
        }));
        const views = m.kind === 'reading'
            ? [['avg', 'Average'], ['peak', 'Peak']]
            : [['daily', 'Per day'], ['total', 'Running total']];
        const viewSeg = ov.querySelector('.sn-views');
        viewSeg.replaceChildren(...views.map(([k, label]) => {
            const b = el('button', k === state.view ? 'is-on' : '', label);
            b.type = 'button';
            b.setAttribute('aria-pressed', String(k === state.view));
            b.addEventListener('click', () => { if (state.view !== k) { state.view = k; renderHead(); renderBody(); } });
            return b;
        }));
    }

    async function load() {
        const ov = state.overlay; if (!ov) return;
        const m = current();
        const req = ++state.req;
        ov.querySelector('.sn-body').classList.add('is-loading');
        try {
            const d = await api(`/home/stats/series/${encodeURIComponent(m.metric)}?days=${state.days}`);
            if (req !== state.req || !state.overlay) return;
            state.data = d;
        } catch (err) {
            if (req !== state.req || !state.overlay) return;
            state.data = { error: err?.message || 'No data for this stat yet.' };
        }
        ov.querySelector('.sn-body').classList.remove('is-loading');
        renderBody();
    }

    /** The values the current view plots, one per bucket (null = gap). */
    function values() {
        const d = state.data;
        if (!d || !d.points) return [];
        if (d.kind === 'reading') return d.points.map((p) => (state.view === 'peak' ? p.peak : p.value));
        if (state.view === 'total') {
            let run = Number(d.before) || 0;
            return d.points.map((p) => (run += p.value));
        }
        return d.points.map((p) => p.value);
    }
    const bucketLabel = (p) => (state.data?.bucket === 'hour' ? hourLabel(p.t) : dayLabel(p.day || p.t));

    function renderBody() {
        const ov = state.overlay; if (!ov) return;
        const d = state.data;
        const m = current();
        const tiles = ov.querySelector('.sn-tiles');
        const plot = ov.querySelector('.sn-plot');
        const table = ov.querySelector('.sn-table');
        const note = ov.querySelector('.sn-note');
        const tBtn = ov.querySelector('.sn-table-btn');
        tBtn.setAttribute('aria-pressed', String(state.table));
        tBtn.classList.toggle('is-on', state.table);
        ov.querySelector('.sn-csv').hidden = !(d && d.points);

        if (!d || d.error || !d.points) {
            tiles.replaceChildren();
            plot.hidden = false; table.hidden = true;
            plot.replaceChildren(el('div', 'sn-empty', d?.error || 'Loading…'));
            note.textContent = '';
            return;
        }

        tiles.replaceChildren(...tileSpecs(d, m).map(([label, value, extra]) => {
            const t = el('div', 'sn-tile');
            t.append(el('span', 'sn-tile-label', label), el('span', 'sn-tile-value', value));
            if (extra) t.append(extra);
            return t;
        }));

        if (d.kind === 'reading') {
            note.textContent = `Sampled every 5 minutes · ${d.bucket === 'hour' ? 'hourly' : 'daily'} ${state.view === 'peak' ? 'peaks' : 'averages'}${d.coverage < 100 ? ` · ${d.coverage}% of this range has samples` : ''}`;
        } else {
            note.textContent = `${d.source === 'media' ? 'From OpenVibe.Media · ' : ''}days in UTC`;
        }

        plot.hidden = state.table;
        table.hidden = !state.table;
        if (state.table) renderTable(); else drawChart();
    }

    function tileSpecs(d, m) {
        const unit = m.unit || '';
        if (d.kind === 'reading') {
            let peakAt = null;
            for (const p of d.points) if (p.peak != null && (peakAt == null || p.peak > peakAt.peak)) peakAt = p;
            return [
                ['Right now', exact(m.now, unit)],
                [`Average · ${rangeName()}`, exact(d.avg, unit)],
                ['Peak', exact(d.peak, unit), peakAt ? el('span', 'sn-tile-sub', bucketLabel(peakAt)) : null],
            ];
        }
        const best = d.points.reduce((a, p) => (p.value > a.value ? p : a), { value: -1 });
        const avg = d.total / d.points.length;
        const tiles = [
            [`Added · ${rangeName()}`, exact(d.total, unit), deltaPill(d.total, d.prev_total)],
            ['Per day', exact(avg, unit)],
            ['Best day', best.value > 0 ? exact(best.value, unit) : '—', best.value > 0 ? el('span', 'sn-tile-sub', dayLabel(best.day)) : null],
        ];
        if (d.before != null) tiles.push(['All time', exact((Number(d.before) || 0) + d.total, unit)]);
        return tiles;
    }
    const rangeName = () => ({ 1: '24h', 7: '7 days', 30: '30 days', 90: '90 days', 365: 'year' }[state.days] || `${state.days}d`);

    /** Change vs the previous window: an arrow and a word, never colour alone. */
    function deltaPill(now, prev) {
        if (prev == null) return null;
        const span = el('span', 'sn-delta');
        if (!prev) {
            if (now > 0) { span.classList.add('is-up'); span.textContent = 'new'; return span; }
            return null;
        }
        const pct = Math.round(((now - prev) / prev) * 100);
        const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
        span.classList.add(`is-${dir}`);
        const arrow = el('i', `fa-solid ${dir === 'up' ? 'fa-arrow-trend-up' : dir === 'down' ? 'fa-arrow-trend-down' : 'fa-minus'}`);
        arrow.setAttribute('aria-hidden', 'true');
        span.append(arrow, document.createTextNode(` ${dir === 'flat' ? 'flat' : `${Math.abs(pct)}%`} vs previous ${rangeName()}`));
        return span;
    }

    // ── Chart ──────────────────────────────────────────────────────────────────
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

    function drawChart() {
        const ov = state.overlay; if (!ov) return;
        const plot = ov.querySelector('.sn-plot');
        const d = state.data;
        const vals = values();
        const W = Math.max(280, Math.round(plot.clientWidth || 640));
        const H = W < 480 ? 200 : 250;
        const padL = 44, padR = 12, padT = 14, padB = 28;
        const n = vals.length;
        const present = vals.filter((v) => v != null);
        const reading = d.kind === 'reading';
        const asLine = reading || state.view === 'total' || n > 120;
        const lo = 0;
        // Average view also draws each bucket's peak as context; both share the one axis.
        const ceiling = reading && state.view === 'avg' ? Math.max(0, ...d.points.map((p) => p.peak ?? 0)) : 0;
        const integer = present.every((v) => Number.isInteger(v)) && !(current().unit);
        const { top, step: tick } = niceScale(Math.max(...present, ceiling, 0), integer);
        const x = (i) => padL + (asLine ? (n === 1 ? (W - padL - padR) / 2 : i * ((W - padL - padR) / (n - 1))) : (i + 0.5) * ((W - padL - padR) / n));
        const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / ((top - lo) || 1));

        const svg = svgEl('svg', { class: 'sn-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
        const unit = current().unit || '';
        plot.setAttribute('aria-label', `${current().label}, ${rangeName()}: ${present.length ? `from ${fmt(present[0], unit)} to ${fmt(present[present.length - 1], unit)}, highest ${fmt(Math.max(...present), unit)}` : 'no data'}. Use the table view for every value.`);

        // Hairline grid on clean ticks, labels in the muted text colour.
        for (let k = 0; k * tick <= top + 1e-9; k++) {
            const v = k * tick;
            const yy = Math.round(y(v)) + 0.5;
            svg.append(svgEl('line', { class: 'sn-grid', x1: padL, x2: W - padR, y1: yy, y2: yy }));
            const t = svgEl('text', { class: 'sn-axis', x: padL - 8, y: yy + 3.5, 'text-anchor': 'end' });
            t.textContent = fmt(v);
            svg.append(t);
        }
        // Sparse x labels: about one per 90px.
        const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - padL - padR) / 90))));
        d.points.forEach((p, i) => {
            if (i % every !== 0 && i !== n - 1) return;
            if (i === n - 1 && i % every !== 0 && (n - 1) % every < every * 0.6) return; // keep the last label from colliding
            const t = svgEl('text', { class: 'sn-axis', x: i === n - 1 && !asLine ? x(i) + ((W - padL - padR) / n) / 2 : x(i), y: H - 9, 'text-anchor': i === 0 && asLine ? 'start' : i === n - 1 ? 'end' : 'middle' });
            t.textContent = d.bucket === 'hour' ? hourLabel(p.t) : dayLabel(p.day || p.t);
            svg.append(t);
        });

        const marks = svgEl('g', { class: 'sn-marks' });
        if (asLine) {
            // Segments break at gaps (no samples) instead of diving to zero.
            let path = '', area = '', run = [];
            const flush = () => {
                if (!run.length) return;
                path += 'M' + run.map((i) => `${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join('L');
                area += `M${x(run[0]).toFixed(1)},${y(lo).toFixed(1)}L` + run.map((i) => `${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join('L') + `L${x(run[run.length - 1]).toFixed(1)},${y(lo).toFixed(1)}Z`;
                run = [];
            };
            vals.forEach((v, i) => { if (v == null) flush(); else run.push(i); });
            flush();
            marks.append(svgEl('path', { class: 'sn-area', d: area }), svgEl('path', { class: 'sn-line', d: path }));
            if (reading && state.view === 'avg') {
                // Context: the peak for each bucket, in gray behind nothing but labelled in the legend.
                let pk = '', seg = [];
                const fl = () => { if (seg.length) pk += 'M' + seg.map((i) => `${x(i).toFixed(1)},${y(d.points[i].peak).toFixed(1)}`).join('L'); seg = []; };
                d.points.forEach((p, i) => { if (p.peak == null) fl(); else seg.push(i); });
                fl();
                marks.insertBefore(svgEl('path', { class: 'sn-line sn-line--context', d: pk }), marks.firstChild);
            }
            // End marker on the latest value.
            const last = vals.length - 1 - [...vals].reverse().findIndex((v) => v != null);
            if (last >= 0 && last < n) {
                marks.append(svgEl('circle', { class: 'sn-dot', cx: x(last), cy: y(vals[last]), r: 4 }));
            }
        } else {
            const slot = (W - padL - padR) / n;
            const bw = Math.max(1, Math.min(24, slot - 2));
            vals.forEach((v, i) => {
                if (!v) return;
                const x0 = x(i) - bw / 2, y0 = y(v), yb = y(0), h = Math.max(1, yb - y0), r = Math.min(4, bw / 2, h);
                // 4px rounded data end, square at the baseline.
                const dAttr = `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${yb}Z`;
                marks.append(svgEl('path', { class: 'sn-bar', d: dAttr, 'data-i': i, style: `animation-delay:${Math.min(0.4, i * (0.4 / n)).toFixed(3)}s` }));
            });
        }
        svg.append(marks);

        // Hover layer: crosshair for lines, lifted bar for columns. The whole plot is the hit area.
        const cross = svgEl('line', { class: 'sn-cross', x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: 'hidden' });
        const hot = svgEl('circle', { class: 'sn-dot sn-dot--hot', r: 5, visibility: 'hidden' });
        svg.append(cross, hot);
        plot.replaceChildren(svg);
        if (reading && state.view === 'avg') plot.append(legend());

        let active = -1;
        const tip = ov.querySelector('.sn-tip');
        const show = (i) => {
            if (i < 0 || i >= n) return;
            active = i;
            const p = d.points[i];
            const v = vals[i];
            marks.querySelectorAll('.sn-bar.is-hot').forEach((b) => b.classList.remove('is-hot'));
            if (asLine) {
                cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
                if (v != null) { hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(v)); hot.setAttribute('visibility', 'visible'); } else hot.setAttribute('visibility', 'hidden');
            } else {
                marks.querySelector(`.sn-bar[data-i="${i}"]`)?.classList.add('is-hot');
            }
            const val = el('div', 'sn-tip-value', v == null ? 'no samples' : exact(v, unit));
            const rows = [val, el('div', 'sn-tip-label', bucketLabel(p))];
            if (reading && state.view === 'avg' && p.peak != null) rows.push(el('div', 'sn-tip-extra', `peak ${exact(p.peak, unit)}`));
            if (!reading && state.view === 'total') rows.push(el('div', 'sn-tip-extra', `+${exact(p.value, unit)} that day`));
            tip.replaceChildren(...rows);
            tip.hidden = false;
            const px = x(i), rect = plot.getBoundingClientRect(), body = plot.parentElement.getBoundingClientRect();
            const left = Math.min(Math.max(px + (rect.left - body.left) - tip.offsetWidth / 2, 4), body.width - tip.offsetWidth - 4);
            const yTop = (v == null ? padT : y(v)) + (rect.top - body.top) - tip.offsetHeight - 12;
            tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(0, yTop))}px)`;
        };
        const hide = () => {
            active = -1; tip.hidden = true;
            cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden');
            marks.querySelectorAll('.sn-bar.is-hot').forEach((b) => b.classList.remove('is-hot'));
        };
        const indexAt = (clientX) => {
            const r = svg.getBoundingClientRect();
            const px = clientX - r.left;
            const i = asLine ? Math.round(((px - padL) / (W - padL - padR)) * (n - 1)) : Math.floor(((px - padL) / (W - padL - padR)) * n);
            return Math.max(0, Math.min(n - 1, i));
        };
        svg.addEventListener('pointermove', (e) => show(indexAt(e.clientX)));
        svg.addEventListener('pointerleave', hide);
        plot.onkeydown = (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
            e.preventDefault(); e.stopPropagation();
            const i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (active < 0 ? n - 1 : active + (e.key === 'ArrowRight' ? 1 : -1));
            show(Math.max(0, Math.min(n - 1, i)));
        };
        plot.onblur = hide;
    }

    function legend() {
        const lg = el('div', 'sn-legend');
        const item = (cls, text) => { const s = el('span', 'sn-legend-item'); s.append(el('i', cls), document.createTextNode(text)); return s; };
        lg.append(item('sn-key sn-key--avg', 'Average'), item('sn-key sn-key--peak', 'Peak'));
        return lg;
    }

    function renderTable() {
        const ov = state.overlay; if (!ov) return;
        const d = state.data;
        const unit = current().unit || '';
        const wrap = ov.querySelector('.sn-table');
        const t = el('table');
        const head = el('tr');
        const cols = d.kind === 'reading' ? [d.bucket === 'hour' ? 'Hour' : 'Day', 'Average', 'Peak'] : ['Day', 'Added', 'Running total'];
        cols.forEach((c) => head.append(el('th', null, c)));
        const thead = el('thead'); thead.append(head);
        const tbody = el('tbody');
        let run = Number(d.before) || 0;
        const rows = d.points.map((p, i) => {
            const tr = el('tr');
            tr.append(el('td', null, bucketLabel(p)));
            if (d.kind === 'reading') {
                tr.append(el('td', 'num', exact(p.value, unit)), el('td', 'num', exact(p.peak, unit)));
            } else {
                run += p.value;
                tr.append(el('td', 'num', exact(p.value, unit)), el('td', 'num', exact(run, unit)));
            }
            return tr;
        });
        rows.reverse().forEach((r) => tbody.append(r)); // newest first
        t.append(thead, tbody);
        wrap.replaceChildren(t);
    }

    function downloadCsv() {
        const d = state.data; if (!d || !d.points) return;
        const m = current();
        const lines = [d.kind === 'reading' ? 'bucket,average,peak' : 'day,value,running_total'];
        let run = Number(d.before) || 0;
        for (const p of d.points) {
            if (d.kind === 'reading') lines.push(`${p.t},${p.value ?? ''},${p.peak ?? ''}`);
            else { run += p.value; lines.push(`${p.day},${p.value},${Math.round(run * 100) / 100}`); }
        }
        const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
        const a = el('a');
        a.href = URL.createObjectURL(blob);
        a.download = `openvibe-${m.metric}-${state.days}d.csv`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    window.openStatsNerds = open;
})();
