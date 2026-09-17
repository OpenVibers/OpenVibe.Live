/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Global chat page (/chat): AI summary panel and timeline browser.

   Split out of app.js, which every page used to download and parse. This file loads with its
   route (public/features.json); it runs after app.js and relies on app.js globals.
   ═══════════════════════════════════════════════════════════════ */
/* ── Global Chat Page ──────────────────────────────────────── */
function loadChatPage() {
    // Connect to global chat (no streamId). initChat loads the history itself — this page used to
    // load and render all 500 rows a second time right after it.
    initChat(null);
    // Global chat AI overview + timeline (refreshed periodically)
    loadGlobalChatAi();
    if (window._globalAiPollTimer) clearInterval(window._globalAiPollTimer);
    window._globalAiPollTimer = setInterval(loadGlobalChatAi, 90000);
}

async function loadGlobalChatAi() {
    const strip = document.getElementById('global-ai-strip');
    const panel = document.getElementById('global-ai-panel');
    if (!strip || !panel) return;
    let insight = null;
    try { insight = (await api('/chat-ai/global')).insight; } catch { /* silent */ }
    if (!insight || !insight.overview) {
        strip.style.display = 'none';
        // Keep the panel only if the user had already opened it.
        if (!panel.classList.contains('gai-user-opened')) panel.style.display = 'none';
        return;
    }
    // Header strip (compact)
    const stripText = document.getElementById('global-ai-strip-text');
    if (stripText) stripText.textContent = insight.overview;
    strip.style.display = 'flex';

    // Full panel
    const ov = document.getElementById('global-ai-overview');
    if (ov) ov.textContent = insight.overview;
    const meta = document.getElementById('global-ai-meta');
    if (meta) {
        const bits = [];
        if (insight.window_label) bits.push(insight.window_label);
        if (insight.updated_at) bits.push('updated ' + _aiTimeAgo(insight.updated_at));
        meta.textContent = bits.join(' · ');
    }
    // The timeline is now a browsable/searchable, infinite-scroll list (fed by /chat-ai/timeline).
    // Initialise once so polling doesn't clobber the user's scroll/search.
    if (document.getElementById('global-ai-timeline') && !_gaiTlInited) { _gaiTlInited = true; _gaiTlInit(); }
    const mem = document.getElementById('global-ai-memory');
    if (mem) mem.textContent = insight.memory || '';
    if (mem && !insight.memory) { mem.innerHTML = '<span class="gai-empty">Still building a picture of the community…</span>'; }
}

// ── Global chat AI timeline browser (search + period jump + infinite scroll) ─────────────
let _gaiTlInited = false;
let _gaiTl = { q: '', since: null, periodBefore: null, oldestTs: 0, loading: false, done: false, lastDay: null };
let _gaiTlSearchTimer = null;

function _gaiTlPeriodBounds(period) {
    const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    switch (period) {
        case 'today': return { since: startOfToday, before: null };
        case 'yesterday': return { since: startOfToday - 86400000, before: startOfToday };
        case 'week': return { since: startOfToday - 6 * 86400000, before: null };
        case 'month': return { since: startOfToday - 29 * 86400000, before: null };
        default: return { since: null, before: null };
    }
}
function _gaiTlPeriod(period, btn) {
    document.querySelectorAll('#gai-tl-periods .gai-tl-chip').forEach(b => b.classList.toggle('active', b === btn));
    const b = _gaiTlPeriodBounds(period);
    _gaiTl.since = b.since; _gaiTl.periodBefore = b.before;
    _gaiTlInit();
}
function _gaiTlSearchDebounced(v) {
    clearTimeout(_gaiTlSearchTimer);
    _gaiTlSearchTimer = setTimeout(() => { _gaiTl.q = (v || '').trim(); _gaiTlInit(); }, 300);
}
function _gaiTlOnScroll(el) {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 90) _gaiTlLoad(false);
}
async function _gaiTlInit() {
    _gaiTl.oldestTs = 0; _gaiTl.done = false; _gaiTl.loading = false; _gaiTl.lastDay = null;
    const el = document.getElementById('global-ai-timeline');
    if (el) { el.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>'; el.scrollTop = 0; }
    await _gaiTlLoad(true);
}
async function _gaiTlLoad(reset) {
    if (_gaiTl.loading || (_gaiTl.done && !reset)) return;
    _gaiTl.loading = true;
    const p = new URLSearchParams({ limit: '25' });
    if (_gaiTl.q) p.set('q', _gaiTl.q);
    if (_gaiTl.since) p.set('since', String(_gaiTl.since));
    if (reset && _gaiTl.periodBefore) p.set('before', String(_gaiTl.periodBefore));
    else if (!reset && _gaiTl.oldestTs) p.set('before', String(_gaiTl.oldestTs));
    let data;
    try { data = await api('/chat-ai/timeline?' + p.toString()); } catch { _gaiTl.loading = false; return; }
    const el = document.getElementById('global-ai-timeline');
    if (!el) { _gaiTl.loading = false; return; }
    const events = data.events || [];
    if (reset) { el.innerHTML = ''; _gaiTl.lastDay = null; }
    if (events.length) {
        el.insertAdjacentHTML('beforeend', _gaiTlRenderGroups(events));
        _gaiTl.oldestTs = new Date(String(events[events.length - 1].ts).replace(' ', 'T') + 'Z').getTime();
    } else if (reset) {
        el.innerHTML = `<div class="gai-empty">${_gaiTl.q ? 'No moments match your search.' : 'No standout moments logged yet.'}</div>`;
    }
    _gaiTl.done = !data.hasMore;
    _gaiTl.loading = false;
}
function _gaiTlDayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dd = new Date(d); dd.setHours(0, 0, 0, 0);
    const diff = Math.round((today - dd) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function _gaiTlRenderGroups(events) {
    let html = '';
    for (const e of events) {
        const d = new Date(String(e.ts).replace(' ', 'T') + 'Z');
        const dayKey = d.toDateString();
        if (dayKey !== _gaiTl.lastDay) { _gaiTl.lastDay = dayKey; html += `<div class="gai-tl-day">${esc(_gaiTlDayLabel(d))}</div>`; }
        html += `<div class="gai-tl-item">
            <div class="gai-tl-when">${esc(_aiTimeAgo(e.ts))}</div>
            <div class="gai-tl-label">${esc(e.label || '')}</div>
            ${e.detail ? `<div class="gai-tl-detail">${esc(e.detail)}</div>` : ''}
        </div>`;
    }
    return html;
}

function toggleGlobalAiPanel() {
    const panel = document.getElementById('global-ai-panel');
    const strip = document.getElementById('global-ai-strip');
    if (!panel) return;
    const showing = panel.style.display !== 'none' && panel.style.display !== '';
    if (showing) {
        panel.style.display = 'none';
        panel.classList.remove('gai-user-opened');
        if (strip) strip.classList.remove('open');
    } else {
        panel.style.display = 'block';
        panel.classList.add('gai-user-opened');
        if (strip) strip.classList.add('open');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}
