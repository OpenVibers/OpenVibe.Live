/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Emote System (Client)
   Loads emotes from FFZ, BTTV, 7TV, defaults, and custom
   (global + channel). Provides emote picker UI and inline
   parsing for chat messages.
   ═══════════════════════════════════════════════════════════════ */

/** All available emotes for the current stream context, keyed by code */
let emoteMap = new Map();
/** Categorised arrays for the picker */
let emoteCategories = { defaults: [], channel: [], global: [], ffz: [], bttv: [], '7tv': [] };
/** Whether emotes have been loaded */
let emotesLoaded = false;
let _emotePickerOpen = false;
let _emotePickerTarget = null; // which picker element is active
let _emoteSearchTimeout = null;

/* ── Load emotes for a stream context ─────────────────────────── */
let _emoteLoadPromise = null;
let _emoteLoadContext = null;

/**
 * Load (and dedupe) emotes for a stream context. Returns a promise so callers can
 * AWAIT emote readiness before rendering — e.g. chat history must wait for emotes or
 * historical messages render raw codes ("PepeD") instead of the emote image. Concurrent
 * or repeat calls for the same context share a single in-flight fetch.
 */
async function loadEmotes(streamId) {
    const key = String(streamId || 0);
    if (emotesLoaded && _emoteLoadContext === key && !_emoteLoadPromise) return;
    if (_emoteLoadPromise && _emoteLoadContext === key) return _emoteLoadPromise;
    _emoteLoadContext = key;
    _emoteLoadPromise = _doLoadEmotes(streamId).finally(() => { _emoteLoadPromise = null; });
    return _emoteLoadPromise;
}

async function _doLoadEmotes(streamId) {
    try {
        const data = await api(`/emotes/all/${streamId || 0}`);
        emoteCategories = {
            defaults: data.defaults || [],
            channel: data.channel || [],
            global: data.global || [],
            ffz: data.ffz || [],
            bttv: data.bttv || [],
            '7tv': data['7tv'] || [],
        };

        // Build lookup map — higher priority sources overwrite lower
        emoteMap.clear();
        for (const e of emoteCategories.bttv)     emoteMap.set(e.code, e);
        for (const e of emoteCategories['7tv'])    emoteMap.set(e.code, e);
        for (const e of emoteCategories.ffz)       emoteMap.set(e.code, e);
        for (const e of emoteCategories.defaults)  emoteMap.set(e.code, e);
        for (const e of emoteCategories.global)    emoteMap.set(e.code, e);
        for (const e of emoteCategories.channel)   emoteMap.set(e.code, e);

        emotesLoaded = true;
        const total = emoteMap.size;
        const cats = emoteCategories;
        console.log(`[Emotes] Loaded ${total} emotes (${cats.defaults.length} defaults, ${cats.channel.length} channel, ${cats.global.length} custom, ${cats.ffz.length} FFZ, ${cats.bttv.length} BTTV, ${cats['7tv'].length} 7TV)`);
    } catch (e) {
        console.warn('[Emotes] Failed to load emotes', e);
    }
}

/* ── Channel sound commands (for the picker's "Channel Sounds" section) ── */
let channelSounds = [];         // [{ command, url, emote_code, count }]
let _soundsLoadContext = null;  // streamId string this list was loaded for

/** Load the channel's !sound commands for a stream context, grouped by command. */
async function loadChannelSounds(streamId) {
    const key = String(streamId || 0);
    if (key === '0') { channelSounds = []; _soundsLoadContext = key; return; }
    try {
        const r = await fetch(`/api/sounds/all/${key}`);
        const d = await r.json();
        const map = new Map();
        for (const s of (d.sounds || [])) {
            if (!s.command) continue;
            let g = map.get(s.command);
            if (!g) { g = { command: s.command, url: s.url, emote_code: s.emote_code || '', count: 0 }; map.set(s.command, g); }
            g.count++;
            if (!g.emote_code && s.emote_code) g.emote_code = s.emote_code;
        }
        channelSounds = [...map.values()].sort((a, b) => a.command.localeCompare(b.command));
        _soundsLoadContext = key;
    } catch (e) {
        console.warn('[Sounds] Failed to load channel sounds', e);
        channelSounds = [];
    }
}

/** Force a live refresh of emotes (used by the 'emotes-updated' WS event + post-upload). */
async function reloadChannelEmotes(streamId) {
    emotesLoaded = false;
    _emoteLoadContext = null;
    await loadEmotes(streamId);
    _refreshOpenEmotePicker();
}
/** Force a live refresh of channel sounds (used by 'sounds-updated' + post-upload). */
async function reloadChannelSounds(streamId) {
    _soundsLoadContext = null;
    await loadChannelSounds(streamId);
    _refreshOpenEmotePicker();
}
/** Re-render the emote picker if it's open on the Emotes tab. */
function _refreshOpenEmotePicker() {
    if (_emotePickerOpen && _emoteMenuMode === 'emotes') {
        try { renderEmotePicker('emotes'); } catch { /* */ }
    }
}

/* ── URL detection regex ───────────────────────────────────────── */
const _URL_RE = /^(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+\.[^\s<>"'`]+)$/i;

/* ── Kick inline emote format: [emote:<id>:<name>] → img tag ─────── */
/* Kick sends the NUMERIC id first, then the name, e.g. [emote:5747992:collectiblespepega]. */
const _KICK_EMOTE_RE = /\[emote:(\d+):([^\]:]+)\]/g;

/** Replace Kick inline [emote:id:name] tokens with <img> tags, return segments */
function _substituteKickEmotes(text) {
    // Returns an array of strings (plain text or img HTML) for eventual joining
    const parts = [];
    let last = 0;
    let m;
    _KICK_EMOTE_RE.lastIndex = 0;
    while ((m = _KICK_EMOTE_RE.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
        const id   = m[1];
        const name = m[2];
        // Validate: id must be purely numeric (already matched \d+), name must be short
        if (id.length <= 12 && name.length <= 64) {
            const url = `https://files.kick.com/emotes/${id}/fullsize`;
            parts.push({ type: 'html', value: `<img class="chat-emote" src="${_escEmote(url)}" alt="${_escEmote(':' + name + ':')}" title="${_escEmote(':' + name + ':')}" loading="lazy" draggable="false">` });
        } else {
            parts.push({ type: 'text', value: m[0] });
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    return parts;
}

/* ── Parse emote codes + linkify URLs in a message string → HTML ── */
function parseEmotes(text) {
    // First pass: expand Kick inline [emote:name:id] tags regardless of loaded state
    const segments = _substituteKickEmotes(text);

    let result;
    if (!emotesLoaded || emoteMap.size === 0) {
        result = segments.map(seg => seg.type === 'html' ? seg.value : _linkifyPlain(seg.value)).join('');
    } else {
        result = segments.map(seg => {
            if (seg.type === 'html') return seg.value;
            const tokens = seg.value.split(/(\s+)/);
            return tokens.map(token => {
                if (/^\s+$/.test(token)) return token;
                const emote = emoteMap.get(token);
                if (emote) {
                    const cls = emote.animated ? 'chat-emote chat-emote-animated' : 'chat-emote';
                    // Per-emote size (percent of base). Multiplies onto the channel scale var.
                    const sz = Number(emote.size);
                    const sizeStyle = (sz && sz !== 100) ? ` style="height:calc(1.6em * var(--chat-emote-scale,1) * ${Math.max(0.25, Math.min(4, sz / 100))})"` : '';
                    return `<img class="${cls}" src="${_escEmote(emote.url)}"${sizeStyle} alt="${_escEmote(token)}" title="${_escEmote(token)}" loading="lazy" draggable="false">`;
                }
                if (_URL_RE.test(token)) return _makeChatLink(token);
                return _escEmote(token);
            }).join('');
        }).join('');
    }

    // Render [gif:url] tags as inline images
    if (typeof renderGifTags === 'function') result = renderGifTags(result);
    return result;
}

/** Linkify plain text (fallback when emotes not loaded) */
function _linkifyPlain(text) {
    return text.split(/(\s+)/).map(token => {
        if (/^\s+$/.test(token)) return token;
        if (_URL_RE.test(token)) return _makeChatLink(token);
        return _escEmote(token);
    }).join('');
}

/** Build a clickable chat link element string */
function _makeChatLink(raw) {
    // Strip trailing punctuation that's unlikely to be part of the URL
    let url = raw;
    let trailing = '';
    const trailingMatch = url.match(/[)}\].,;:!?]+$/);
    if (trailingMatch) {
        const stripped = trailingMatch[0];
        const openParens = (url.match(/\(/g) || []).length;
        const closeParens = (url.match(/\)/g) || []).length;
        if (closeParens > openParens && stripped.includes(')')) {
            trailing = stripped;
            url = url.slice(0, -stripped.length);
        } else if (!stripped.includes(')')) {
            trailing = stripped;
            url = url.slice(0, -stripped.length);
        }
    }
    const href = url.startsWith('www.') ? 'https://' + url : url;
    const escaped = _escEmote(url);
    const escapedHref = _escEmote(href);
    return `<a class="chat-link" href="${escapedHref}" data-url="${escapedHref}" onclick="handleChatLinkClick(event)" oncontextmenu="showLinkContextMenu(event)" title="${escapedHref}">${escaped}</a>${_escEmote(trailing)}`;
}
function _escEmote(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════════
   EMOTE PICKER — supports both channel chat and broadcast chat
   ══════════════════════════════════════════════════════════════ */

/**
 * Detect which picker + grid to use based on the target input.
 * Returns { picker, grid, search } DOM elements.
 */
function _getPickerEls(inputId) {
    const isBc = inputId && inputId.startsWith('bc-');
    const isGlobal = inputId === 'global-chat-input';
    const isOffline = inputId === 'offline-chat-input';
    const prefix = isBc ? 'bc-' : isGlobal ? 'gc-' : isOffline ? 'oc-' : '';
    return {
        picker: document.getElementById(prefix + 'emote-picker'),
        grid:   document.getElementById(prefix + 'emote-picker-grid'),
        search: prefix
            ? document.querySelector('#' + prefix + 'emote-picker .emote-search')
            : document.getElementById('emote-search'),
    };
}

let _emoteMenuMode = 'emotes'; // 'emotes' | 'gif'
let _gifProviderCache = null;

// Slack-style category order — channel (the stream's own) emotes pinned at top.
const EMOTE_CATEGORY_ORDER = [
    { key: 'channel', label: 'Channel Emotes', icon: 'fa-star' },
    { key: 'global', label: 'Custom', icon: 'fa-face-grin-stars' },
    { key: 'defaults', label: 'Popular', icon: 'fa-fire' },
    { key: 'ffz', label: 'FrankerFaceZ', icon: '' },
    { key: '7tv', label: '7TV', icon: '' },
    { key: 'bttv', label: 'BetterTTV', icon: '' },
];

// Rebuild the top tab bar into two tabs: Emotes | GIF.
function _buildEmoteMenuTabs(picker) {
    const tabs = picker.querySelector('.emote-picker-tabs');
    if (!tabs) return;
    tabs.innerHTML = `
        <button class="emote-tab-btn ${_emoteMenuMode === 'emotes' ? 'active' : ''}" data-tab="emotes" onclick="renderEmotePicker('emotes')"><i class="fa-solid fa-face-smile"></i> Emotes</button>
        <button class="emote-tab-btn ${_emoteMenuMode === 'gif' ? 'active' : ''}" data-tab="gif" onclick="renderEmotePicker('gif')"><i class="fa-solid fa-film"></i> GIF</button>`;
    const searchEl = picker.querySelector('.emote-search');
    if (searchEl) searchEl.placeholder = 'Search emotes or GIFs…';
}

function toggleEmotePicker(inputId) {
    const { picker } = _getPickerEls(inputId);
    if (!picker) return;

    // Close any other open picker first
    if (_emotePickerTarget && _emotePickerTarget !== inputId) {
        const prev = _getPickerEls(_emotePickerTarget);
        if (prev.picker) prev.picker.style.display = 'none';
    }

    _emotePickerOpen = !_emotePickerOpen || _emotePickerTarget !== inputId;
    _emotePickerTarget = inputId;
    picker.style.display = _emotePickerOpen ? 'flex' : 'none';
    picker.dataset.targetInput = inputId || 'chat-input';

    if (_emotePickerOpen) {
        _emoteMenuMode = 'emotes';
        _buildEmoteMenuTabs(picker);
        // Lazy-load this channel's sound commands the first time the menu opens for it.
        const _sid = (typeof chatStreamId !== 'undefined') ? chatStreamId : 0;
        if (typeof loadChannelSounds === 'function' && _soundsLoadContext !== String(_sid || 0)) {
            loadChannelSounds(_sid).then(_refreshOpenEmotePicker);
        }
        renderEmotePicker('emotes');
    }
}

function renderEmotePicker(mode) {
    // Accept legacy tab names ('all'/'channel'/…) → treat as the emotes list.
    if (mode !== 'gif') mode = 'emotes';
    _emoteMenuMode = mode;
    const { grid, search, picker } = _getPickerEls(_emotePickerTarget);
    if (!grid) return;
    if (picker) picker.querySelectorAll('.emote-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === mode));
    grid.classList.toggle('emote-grid-list', mode === 'emotes');

    if (mode === 'gif') { _renderGifTab(grid, search); return; }

    const query = (search?.value || '').toLowerCase().trim();
    const soundsHtml = _renderChannelSoundsSection(query);
    let soundsInserted = false;
    let html = '';
    for (const cat of EMOTE_CATEGORY_ORDER) {
        let list = emoteCategories[cat.key] || [];
        if (query) list = list.filter(e => e.code.toLowerCase().includes(query));
        if (list.length) {
            html += `<div class="emote-cat-header">${cat.icon ? `<i class="fa-solid ${cat.icon}"></i> ` : ''}${cat.label}<span class="emote-cat-count">${list.length}</span></div>`;
            html += '<div class="emote-cat-grid">' + list.slice(0, 200).map(e => {
                const cls = e.animated ? 'emote-picker-item emote-animated' : 'emote-picker-item';
                return `<div class="${cls}" title="${_escEmote(e.code)}" onclick="insertEmote('${_escEmote(e.code).replace(/'/g, "\\'")}')"><img src="${e.url}" alt="${_escEmote(e.code)}" loading="lazy" draggable="false"></div>`;
            }).join('') + '</div>';
        }
        // "Channel Sounds" sits directly under "Channel Emotes".
        if (cat.key === 'channel') { html += soundsHtml; soundsInserted = true; }
    }
    if (!soundsInserted) html += soundsHtml;
    grid.innerHTML = html || '<div class="emote-picker-empty">No emotes found</div>';
}

/** Render the "Channel Sounds" section: click a tile to send its !command. */
function _renderChannelSoundsSection(query) {
    let list = channelSounds || [];
    if (query) {
        const q = query.replace(/^!/, '');
        list = list.filter(s => s.command.toLowerCase().includes(q));
    }
    if (!list.length) return '';
    let h = `<div class="emote-cat-header"><i class="fa-solid fa-volume-high"></i> Channel Sounds<span class="emote-cat-count">${list.length}</span></div>`;
    h += '<div class="emote-sound-grid">' + list.slice(0, 200).map(s => {
        const cmd = _escEmote(s.command);
        const cmdArg = cmd.replace(/'/g, "\\'");
        const emote = (s.emote_code && emoteMap && emoteMap.get) ? emoteMap.get(s.emote_code) : null;
        let inner;
        if (emote) {
            const cls = emote.animated ? 'emote-sound-img emote-animated' : 'emote-sound-img';
            inner = `<span class="emote-sound-bang">!</span><img class="${cls}" src="${emote.url}" alt="!${cmd}" loading="lazy" draggable="false">`;
        } else {
            inner = `<span class="emote-sound-cmd">!${cmd}</span>`;
        }
        return `<div class="emote-sound-tile" title="Send !${cmd}" onclick="sendChannelSound('${cmdArg}')">${inner}</div>`;
    }).join('') + '</div>';
    return h;
}

/** Send a channel sound command (!cmd) chosen from the picker. */
function sendChannelSound(command) {
    const picker = _getPickerEls(_emotePickerTarget).picker;
    const inputId = picker?.dataset.targetInput || _emotePickerTarget || 'chat-input';
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = '!' + command;
    if (picker) picker.style.display = 'none';
    _emotePickerOpen = false;
    if (typeof sendChat === 'function') sendChat(input);
}

// ── GIF tab (folded into the emote menu) ──────────────────────
async function _gifDefaultProvider() {
    if (_gifProviderCache !== null) return _gifProviderCache;
    try {
        const r = await fetch('/api/chat/gif/providers');
        const d = await r.json();
        _gifProviderCache = d.defaultProvider || null;
    } catch { _gifProviderCache = null; }
    return _gifProviderCache;
}

async function _renderGifTab(grid, search) {
    grid.innerHTML = '<div class="emote-picker-empty">Loading GIFs…</div>';
    const provider = await _gifDefaultProvider();
    if (!provider) { grid.innerHTML = '<div class="emote-picker-empty">GIF search isn’t configured.</div>'; return; }
    const q = (search?.value || '').trim();
    const url = (q.length >= 2)
        ? `/api/chat/gif/search?provider=${provider}&q=${encodeURIComponent(q)}`
        : `/api/chat/gif/trending?provider=${provider}`;
    try {
        const r = await fetch(url);
        const d = await r.json();
        const gifs = d.results || [];
        if (!gifs.length) { grid.innerHTML = '<div class="emote-picker-empty">No GIFs found</div>'; return; }
        grid.innerHTML = '<div class="emote-gif-grid">' + gifs.map(g =>
            `<div class="emote-gif-item" title="${_escEmote(g.title || 'GIF')}" onclick="_insertGifFromMenu('${_escEmote(g.full_url).replace(/'/g, "\\'")}')"><img src="${_escEmote(g.preview_url)}" loading="lazy" alt="GIF"></div>`
        ).join('') + '</div>';
    } catch { grid.innerHTML = '<div class="emote-picker-empty">GIFs unavailable</div>'; }
}

function _insertGifFromMenu(url) {
    const picker = _getPickerEls(_emotePickerTarget).picker;
    const inputId = picker?.dataset.targetInput || _emotePickerTarget || 'chat-input';
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = `[gif:${url}]`;
    if (picker) picker.style.display = 'none';
    _emotePickerOpen = false;
    if (typeof sendChat === 'function') sendChat(input);
}

function insertEmote(code) {
    const picker = _getPickerEls(_emotePickerTarget).picker;
    const inputId = picker?.dataset.targetInput || _emotePickerTarget || 'chat-input';
    const input = document.getElementById(inputId);
    if (!input) return;

    const cursor = input.selectionStart || input.value.length;
    const before = input.value.slice(0, cursor);
    const after = input.value.slice(cursor);
    const space = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
    const trailing = after.startsWith(' ') || after.length === 0 ? '' : ' ';
    input.value = before + space + code + trailing + after;
    input.focus();
    const newPos = cursor + space.length + code.length + trailing.length;
    input.setSelectionRange(newPos, newPos);
}

function onEmoteSearch(value) {
    clearTimeout(_emoteSearchTimeout);
    _emoteSearchTimeout = setTimeout(() => {
        if (!_getPickerEls(_emotePickerTarget).picker) return;
        renderEmotePicker(_emoteMenuMode);
    }, 150);
}

/* ── FFZ Search (remote) ──────────────────────────────────────── */
async function searchFFZEmotes(query) {
    if (!query || query.length < 2) return;
    const { grid } = _getPickerEls(_emotePickerTarget);
    if (!grid) return;
    grid.innerHTML = '<div class="emote-picker-empty"><i class="fa-solid fa-spinner fa-spin"></i> Searching FFZ...</div>';

    try {
        const data = await api(`/emotes/search?q=${encodeURIComponent(query)}`);
        const emotes = data.emotes || [];
        if (!emotes.length) {
            grid.innerHTML = '<div class="emote-picker-empty">No FFZ emotes found</div>';
            return;
        }
        grid.innerHTML = emotes.map(e => {
            const cls = e.animated ? 'emote-picker-item emote-animated' : 'emote-picker-item';
            return `<div class="${cls}" title="${_escEmote(e.code)}" onclick="insertEmote('${_escEmote(e.code).replace(/'/g, "\\'")}')">
                <img src="${e.url}" alt="${_escEmote(e.code)}" loading="lazy" draggable="false">
            </div>`;
        }).join('');
    } catch {
        grid.innerHTML = '<div class="emote-picker-empty">Search failed</div>';
    }
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD — Manage My Emotes
   ══════════════════════════════════════════════════════════════ */

async function loadDashEmotes() {
    const container = document.getElementById('dash-emotes-list');
    if (!container) return;

    // Load source preferences
    loadDashEmoteSources();

    try {
        const data = await api('/emotes/mine');
        const emotes = data.emotes || [];
        const count = data.count || 0;
        const max = data.max || 50;

        const countEl = document.getElementById('dash-emote-count');
        if (countEl) countEl.textContent = `${count} / ${max}`;

        if (!emotes.length) {
            container.innerHTML = '<p class="muted">No custom emotes yet. Upload your first emote!</p>';
            return;
        }

        container.innerHTML = emotes.map(e => `
            <div class="dash-emote-item">
                <img src="${e.url}" alt="${_escEmote(e.code)}" class="${e.animated ? 'emote-animated' : ''}">
                <span class="dash-emote-code">${_escEmote(e.code)}</span>
                ${e.is_global ? '<span class="badge badge-accent">Global</span>' : ''}
                <button class="btn btn-small btn-danger" onclick="deleteDashEmote(${e.id})">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch {
        container.innerHTML = '<p class="muted">Failed to load emotes</p>';
    }
}

async function loadDashEmoteSources() {
    try {
        const data = await api('/emotes/sources');
        const src = data.sources || {};
        const ids = { defaults: 'emote-src-defaults', custom: 'emote-src-custom', ffz: 'emote-src-ffz', bttv: 'emote-src-bttv', '7tv': 'emote-src-7tv' };
        for (const [key, elId] of Object.entries(ids)) {
            const el = document.getElementById(elId);
            if (el) el.checked = src[key] !== false;
        }
    } catch { /* silent */ }
}

async function saveEmoteSources() {
    const sources = {
        defaults: document.getElementById('emote-src-defaults')?.checked ?? true,
        custom:   document.getElementById('emote-src-custom')?.checked ?? true,
        ffz:      document.getElementById('emote-src-ffz')?.checked ?? true,
        bttv:     document.getElementById('emote-src-bttv')?.checked ?? true,
        '7tv':    document.getElementById('emote-src-7tv')?.checked ?? true,
    };
    try {
        await api('/emotes/sources', { method: 'PUT', body: sources });
        toast('Emote sources saved', 'success');
    } catch (e) {
        toast(e.message || 'Failed to save', 'error');
    }
}

async function uploadDashEmote() {
    const codeInput = document.getElementById('emote-upload-code');
    const fileInput = document.getElementById('emote-upload-file');
    if (!codeInput || !fileInput) return;

    const code = codeInput.value.trim();
    if (!code) return toast('Enter an emote code', 'error');
    if (!fileInput.files.length) return toast('Select an image file', 'error');

    const formData = new FormData();
    formData.append('code', code);
    formData.append('image', fileInput.files[0]);

    try {
        const tok = localStorage.getItem('token');
        const res = await fetch('/api/emotes', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tok}` },
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw { message: data.error };
        toast(`Emote "${code}" uploaded!`, 'success');
        codeInput.value = '';
        fileInput.value = '';
        loadDashEmotes();
    } catch (e) {
        toast(e.message || 'Upload failed', 'error');
    }
}

async function deleteDashEmote(id) {
    if (!confirm('Delete this emote?')) return;
    try {
        await api(`/emotes/${id}`, { method: 'DELETE' });
        toast('Emote deleted', 'success');
        loadDashEmotes();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Close picker on outside click ────────────────────────────── */
document.addEventListener('click', (e) => {
    if (!_emotePickerOpen) return;
    if (e.target.closest('.emote-picker') || e.target.closest('.emote-picker-btn')) return;
    _emotePickerOpen = false;
    // Close all four pickers (main / broadcast / offline / global).
    ['emote-picker', 'bc-emote-picker', 'oc-emote-picker', 'gc-emote-picker'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
});
