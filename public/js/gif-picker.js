// ── State ─────────────────────────────────────────────────────
let _gifPickerOpen = false;
let _gifPickerTarget = 'chat-input';
let _gifSearchDebounce = null;
let _gifsEnabled = true;
let _gifPickerEl = null;
let _gifProviders = { tenor: false, giphy: false };
let _gifProvider = 'tenor';
let _gifProvidersLoaded = false;
let _gifProvidersPromise = null;

const GIF_ALLOWED_DOMAINS = ['tenor.com', 'media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
const GIF_TAG_RE = /\[gif:(https?:\/\/[^\]]+)\]/g;

/**
 * Validate that a URL points to an allowed GIF domain.
 */
function isAllowedGifUrl(url) {
    try {
        const parsed = new URL(url);
        return GIF_ALLOWED_DOMAINS.includes(parsed.hostname);
    } catch { return false; }
}

/**
 * Parse [gif:url] tags in message text and return HTML with inline images.
 * Called from parseEmotes() flow.
 */
function renderGifTags(html) {
    if (!_gifsEnabled) return html;
    return html.replace(GIF_TAG_RE, (match, url) => {
        if (!isAllowedGifUrl(url)) return match; // leave as text if untrusted domain
        const safeUrl = url.replace(/[<>"']/g, ''); // basic attribute safety
        return `<img class="chat-gif" src="${safeUrl}" alt="GIF" loading="lazy" draggable="false" onclick="window.open('${safeUrl}','_blank')">`;
    });
}

/**
 * Set whether GIFs are enabled (called when joining a channel).
 */
function setGifsEnabled(enabled) {
    _gifsEnabled = enabled;
    updateGifButtonsState();
    if (!enabled) closeGifPicker();
}

/**
 * Compatibility shim for older callers. API keys now stay server-side.
 */
function setGifApiKey() {
    return undefined;
}

// ── GIF Picker UI ──────────────────────────────────────────────

function _getGifPicker() {
    if (_gifPickerEl && document.body.contains(_gifPickerEl)) return _gifPickerEl;
    _gifPickerEl = document.getElementById('gif-picker-global');
    if (_gifPickerEl) return _gifPickerEl;

    const picker = document.createElement('div');
    picker.id = 'gif-picker-global';
    picker.className = 'gif-picker';
    picker.style.display = 'none';
    picker.innerHTML = `
        <div class="gif-picker-header">
            <div class="gif-picker-provider-row"></div>
            <input type="text" class="gif-search" placeholder="Search GIFs..." oninput="onGifSearch(this.value)">
        </div>
        <div class="gif-picker-grid"></div>
        <div class="gif-picker-footer">
            <span class="muted gif-picker-footer-text" style="font-size:0.7rem">Powered by GIF search</span>
        </div>
    `;

    picker.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', (event) => {
        if (!_gifPickerOpen || !_gifPickerEl) return;
        if (_gifPickerEl.contains(event.target)) return;
        closeGifPicker();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && _gifPickerOpen) closeGifPicker();
    });

    _gifPickerEl = picker;
    return picker;
}

function _getGifProviderLabel(provider) {
    return provider === 'giphy' ? 'Giphy' : 'Tenor';
}

function _renderGifProviderButtons() {
    const picker = _getGifPicker();
    const row = picker.querySelector('.gif-picker-provider-row');
    if (!row) return;
    const activeProviders = Object.entries(_gifProviders).filter(([, enabled]) => !!enabled);
    row.innerHTML = activeProviders.map(([provider]) => {
        const active = provider === _gifProvider ? ' is-active' : '';
        return `<button type="button" class="gif-provider-btn${active}" onclick="selectGifProvider('${provider}')">${_getGifProviderLabel(provider)}</button>`;
    }).join('');
    row.style.display = activeProviders.length > 1 ? 'flex' : 'none';
    const footerText = picker.querySelector('.gif-picker-footer-text');
    if (footerText) footerText.textContent = activeProviders.length ? `Powered by ${_getGifProviderLabel(_gifProvider)}` : 'GIF search unavailable';
}

function updateGifButtonsState() {
    document.querySelectorAll('.gif-btn').forEach((btn) => {
        btn.disabled = !_gifsEnabled;
        btn.style.opacity = _gifsEnabled ? '' : '0.5';
        btn.title = _gifsEnabled ? 'GIFs' : 'This streamer has disabled GIFs';
    });
}

async function loadGifProviders(force = false) {
    if (_gifProvidersLoaded && !force) return _gifProviders;
    if (_gifProvidersPromise && !force) return _gifProvidersPromise;

    _gifProvidersPromise = (async () => {
        try {
            const res = await fetch('/api/chat/gif/providers', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            _gifProviders = {
                tenor: !!data?.providers?.tenor,
                giphy: !!data?.providers?.giphy,
            };
            _gifProvider = data?.defaultProvider || (_gifProviders.tenor ? 'tenor' : (_gifProviders.giphy ? 'giphy' : 'tenor'));
        } catch {
            _gifProviders = { tenor: false, giphy: false };
            _gifProvider = 'tenor';
        }
        _gifProvidersLoaded = true;
        _renderGifProviderButtons();
        return _gifProviders;
    })();

    return _gifProvidersPromise;
}

function selectGifProvider(provider) {
    if (!_gifProviders[provider]) return;
    _gifProvider = provider;
    _renderGifProviderButtons();
    const query = _getGifPicker().querySelector('.gif-search')?.value?.trim() || '';
    if (query.length >= 2) _searchGifs(query);
    else _loadTrendingGifs();
}

function _attachGifPicker(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return false;
    const area = input.closest('.chat-input-area');
    if (!area) return false;
    const picker = _getGifPicker();
    if (picker.parentElement !== area) area.insertBefore(picker, area.firstChild);
    return true;
}

function initGifPickers() {
    ['chat-input', 'offline-chat-input', 'bc-chat-input', 'global-chat-input'].forEach((id) => {
        const input = document.getElementById(id);
        const area = input?.closest('.chat-input-area');
        if (area) area.dataset.hasGifPicker = '1';
    });
    _getGifPicker();
    updateGifButtonsState();
    loadGifProviders();
}

/**
 * Toggle the GIF picker for a specific chat input.
 */
async function toggleGifPicker(inputId) {
    if (!_gifsEnabled) return;
    _gifPickerTarget = inputId || 'chat-input';
    if (!_attachGifPicker(_gifPickerTarget)) return;

    const picker = _getGifPicker();
    await loadGifProviders();
    if (!_gifProviders.tenor && !_gifProviders.giphy) {
        _renderGifGrid('<p class="muted" style="padding:12px">GIF search is not configured yet</p>');
        picker.style.display = 'flex';
        _gifPickerOpen = true;
        return;
    }

    _gifPickerOpen = !_gifPickerOpen;
    picker.style.display = _gifPickerOpen ? 'flex' : 'none';

    if (_gifPickerOpen) {
        const search = picker.querySelector('.gif-search');
        if (search) { search.value = ''; search.focus(); }
        _renderGifProviderButtons();
        _loadTrendingGifs();
    }
}

/**
 * Close the GIF picker if open.
 */
function closeGifPicker() {
    _gifPickerOpen = false;
    const picker = _getGifPicker();
    if (picker) picker.style.display = 'none';
}

/**
 * Search Tenor for GIFs.
 */
function onGifSearch(query) {
    clearTimeout(_gifSearchDebounce);
    _gifSearchDebounce = setTimeout(() => {
        if (!query || query.length < 2) {
            _loadTrendingGifs();
        } else {
            _searchGifs(query);
        }
    }, 300);
}

async function _loadTrendingGifs() {
    try {
        const res = await fetch(`/api/chat/gif/trending?provider=${encodeURIComponent(_gifProvider)}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Failed to load GIFs');
        _renderGifResults(data.results || []);
    } catch {
        _renderGifGrid('<p class="muted" style="padding:12px">Failed to load GIFs</p>');
    }
}

async function _searchGifs(query) {
    try {
        const res = await fetch(`/api/chat/gif/search?provider=${encodeURIComponent(_gifProvider)}&q=${encodeURIComponent(query)}`, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Search failed');
        _renderGifResults(data.results || []);
    } catch {
        _renderGifGrid('<p class="muted" style="padding:12px">Search failed</p>');
    }
}

function _renderGifResults(results) {
    if (!results.length) {
        _renderGifGrid('<p class="muted" style="padding:12px">No GIFs found</p>');
        return;
    }
    const html = results.map(r => {
        const tiny = r.preview_url || '';
        const full = r.full_url || tiny;
        if (!tiny) return '';
        return `<img class="gif-picker-item" src="${tiny.replace(/[<>"']/g, '')}" alt="${String(r.title || 'GIF').replace(/[<>"']/g, '')}" loading="lazy" onclick="selectGif('${full.replace(/'/g, "\\'")}')">`;
    }).join('');
    _renderGifGrid(html);
}

function _renderGifGrid(html) {
    const grid = _getGifPicker().querySelector('.gif-picker-grid');
    if (grid) grid.innerHTML = html;
}

/**
 * Insert selected GIF URL into the target chat input.
 */
function selectGif(url) {
    if (!isAllowedGifUrl(url)) return;
    const input = document.getElementById(_gifPickerTarget);
    if (!input) return;

    // Replace the entire message with just the GIF tag (GIF-only messages)
    input.value = `[gif:${url}]`;
    input.focus();
    closeGifPicker();

    // Auto-send if the input has a send handler
    if (typeof sendChat === 'function') {
        sendChat(input);
    }
}

/**
 * Backward-compatible no-op: the picker is now a shared movable instance.
 */
function ensureGifPicker() {
    initGifPickers();
}
