/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Pastes & Screenshots
   Pastebin-style sharing with syntax highlighting, screenshot capture,
   public/unlisted modes, burn-after-read, and chat integration.
   ═══════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────
let _pastesLoaded = false;
let _pastesOffset = 0;
let _pastesFilter = 'all'; // 'all' | 'paste' | 'screenshot'
let _pastesUser = 'all';   // 'all' | <username>
let _pastesSearch = '';
let _pastesSort = 'newest'; // 'newest' | 'oldest'
let _pastesTotal = 0;
let _pastesCooldownUntil = 0; // timestamp (ms) until next paste allowed
let _pasteLimitCache = null; // cached config from /pastes/config
let _pasteLimitCacheTime = 0;
const PASTES_PER_PAGE = 30;
const PASTE_LIMIT_CACHE_TTL = 60000; // 1 minute

// ── Syntax highlighting (lightweight, no lib needed) ────────
const _hlKeywords = {
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|instanceof|in|of|switch|case|break|continue|default|null|undefined|true|false)\b/g,
    python: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|in|not|and|or|is|None|True|False|print|self|lambda|yield|raise|pass|break|continue|global|nonlocal)\b/g,
    html: /(&lt;\/?[a-zA-Z][a-zA-Z0-9]*|&gt;)/g,
    sql: /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT|UNION|EXISTS|BETWEEN|LIKE|IN|IS|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END)\b/gi,
    rust: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|self|Self|match|if|else|for|while|loop|return|break|continue|async|await|move|ref|where|type|true|false|None|Some|Ok|Err)\b/g,
    go: /\b(func|package|import|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|select|nil|true|false|make|new|len|cap|append)\b/g,
    php: /\b(function|class|public|private|protected|static|return|if|else|elseif|for|foreach|while|switch|case|break|continue|echo|print|new|null|true|false|array|isset|empty|require|include|namespace|use|try|catch|throw)\b/g,
    bash: /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|local|export|readonly|declare|echo|exit|source|eval|exec|set|unset|shift|cd|pwd|test)\b/g,
};

function highlightSyntax(code, lang) {
    // Escape HTML
    let html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (lang === 'text' || lang === 'markdown') return html;

    // Strings
    html = html.replace(/(["'`])(?:(?!\1|\\).|\\.)*?\1/g, '<span class="paste-hl-str">$&</span>');
    // Comments (// and #)
    html = html.replace(/(\/\/.*$|#(?!!).*$)/gm, '<span class="paste-hl-cmt">$&</span>');
    // Numbers
    html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="paste-hl-num">$&</span>');
    // Keywords
    const kwPattern = _hlKeywords[lang] || _hlKeywords.javascript;
    if (kwPattern) {
        html = html.replace(kwPattern, '<span class="paste-hl-kw">$&</span>');
    }
    return html;
}

// ── Load pastes index page ──────────────────────────────────
function loadPastesPage() {
    _pastesOffset = 0;
    _pastesFilter = 'all';
    _pastesUser = 'all';
    _pastesSearch = '';
    _pastesSort = 'newest';
    _pastesLoaded = true;

    const grid = document.getElementById('pastes-grid');
    if (grid) grid.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    fetchPastes();
}

async function fetchPastes() {
    const grid = document.getElementById('pastes-grid');
    if (!grid) return;

    try {
        let url = `/pastes?limit=${PASTES_PER_PAGE}&offset=${_pastesOffset}`;
        if (_pastesFilter !== 'all') url += `&type=${_pastesFilter}`;
        if (_pastesUser !== 'all') url += `&username=${encodeURIComponent(_pastesUser)}`;
        if (_pastesSearch) url += `&search=${encodeURIComponent(_pastesSearch)}`;
        if (_pastesSort === 'oldest') url += `&sort=oldest`;

        const data = await api(url);
        _pastesTotal = data.total || 0;

        // Per-user filter bar (reuses the shared VOD/clip filter renderer).
        if (typeof renderMediaStreamerFilters === 'function') {
            renderMediaStreamerFilters({
                barId: 'pastes-streamer-filters',
                streamers: data.users || [],
                activeFilter: _pastesUser,
                onSelect: 'setPastesUserFilter',
                countKey: 'paste_count',
                allLabel: 'All users',
            });
        }

        document.getElementById('pastes-count').textContent = `${_pastesTotal} item${_pastesTotal !== 1 ? 's' : ''}`;

        if (!data.pastes?.length && _pastesOffset === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; text-align:center; padding:48px 20px;">
                    <i class="fa-solid fa-paste" style="font-size:2.5rem; opacity:0.3; margin-bottom:12px;"></i>
                    <p style="opacity:0.5;">No pastes yet. Share something!</p>
                </div>`;
            return;
        }

        grid.innerHTML = data.pastes.map(p => renderPasteCard(p)).join('');

        // Admin bulk-select (ctrl/shift multi-select + bulk delete) on the pastes index,
        // mirroring the global VODs/Clips pages. No-op for non-admins (cards stay plain links).
        if (typeof _selSetContext === 'function' && typeof _isContentAdmin === 'function') {
            _selSetContext(_isContentAdmin(), fetchPastes);
        }

        // Pagination
        const pagEl = document.getElementById('pastes-pagination');
        if (pagEl) {
            const totalPages = Math.ceil(_pastesTotal / PASTES_PER_PAGE);
            const currentPage = Math.floor(_pastesOffset / PASTES_PER_PAGE) + 1;
            const sortHtml = (typeof sortToggleHTML === 'function') ? sortToggleHTML(_pastesSort, 'pastesSort') : '';
            let pageHtml = '';
            if (totalPages > 1) {
                if (currentPage > 1) pageHtml += `<button class="btn btn-outline btn-sm" onclick="pastesPaginate(${_pastesOffset - PASTES_PER_PAGE})"><i class="fa-solid fa-chevron-left"></i> Prev</button>`;
                pageHtml += `<span class="pastes-page-info">Page ${currentPage} of ${totalPages}</span>`;
                if (currentPage < totalPages) pageHtml += `<button class="btn btn-outline btn-sm" onclick="pastesPaginate(${_pastesOffset + PASTES_PER_PAGE})">Next <i class="fa-solid fa-chevron-right"></i></button>`;
            }
            pagEl.innerHTML = sortHtml + pageHtml;
            pagEl.style.display = (sortHtml || pageHtml) ? '' : 'none';
        }
    } catch (err) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;text-align:center;padding:48px;"><p style="color:var(--danger);">Failed to load pastes</p></div>`;
    }
}

function renderPasteCard(p) {
    const isScreenshot = p.type === 'screenshot';
    const timeAgo = formatTimeAgo(p.created_at);
    const author = p.username || 'Anonymous';
    const avatar = p.avatar_url
        ? `<img src="${escapeHtml(p.avatar_url)}" class="paste-card-avatar" alt="">`
        : `<div class="paste-card-avatar paste-card-avatar-letter">${author[0].toUpperCase()}</div>`;

    const langBadge = !isScreenshot && p.language && p.language !== 'text'
        ? `<span class="paste-card-lang">${escapeHtml(p.language)}</span>` : '';
    const pinBadge = p.pinned ? `<span class="paste-card-pin" title="Pinned"><i class="fa-solid fa-thumbtack"></i></span>` : '';
    const burnBadge = p.burn_after_read ? `<span class="paste-card-burn" title="Burns after reading"><i class="fa-solid fa-fire"></i></span>` : '';
    const nsfwBadge = p.is_nsfw ? `<span class="paste-card-nsfw" title="NSFW">NSFW</span>` : '';
    const viewsBadge = `<span class="paste-card-views"><i class="fa-solid fa-eye"></i> ${p.views || 0}</span>`;
    const likesBadge = `<span class="paste-card-likes"><i class="fa-solid fa-thumbs-up"></i> ${p.likes || 0}</span>`;

    let thumb = '';
    if (isScreenshot && p.screenshot_url) {
        thumb = `<div class="paste-card-thumb"><img src="${escapeHtml(p.screenshot_url)}" alt="Screenshot" loading="lazy"></div>`;
    } else {
        // Code preview
        const preview = (p.content || '').slice(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        thumb = `<div class="paste-card-code"><pre><code>${preview}${(p.content || '').length > 200 ? '…' : ''}</code></pre></div>`;
    }
    const nsfwBlur = p.is_nsfw ? ' paste-card-nsfw-blur' : '';

    const _cardInner = `
        <a class="paste-card${nsfwBlur}" href="/p/${p.slug}" onclick="return handleLinkClick(event, '/p/${p.slug}')">
            ${thumb}
            <div class="paste-card-info">
                <div class="paste-card-title">${pinBadge}${nsfwBadge}${escapeHtml(p.title)}${burnBadge}</div>
                <div class="paste-card-meta">
                    <div class="paste-card-author">${avatar}<span>${escapeHtml(author)}</span></div>
                    <div class="paste-card-right">
                        ${langBadge}${likesBadge}${viewsBadge}
                        <span class="paste-card-time">${timeAgo}</span>
                    </div>
                </div>
                ${(typeof _cardAiHTML === 'function') ? _cardAiHTML(p.ai_summary) : ((p.ai_summary && p.ai_summary.trim()) ? `<div class="card-ai-overview"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(p.ai_summary)}</div>` : '')}
            </div>
        </a>`;
    // Wrap for admin bulk-select (ctrl/shift multi-select + bulk delete) when enabled.
    return (typeof _selWrap === 'function') ? _selWrap('paste', p.slug, _cardInner, !!p.owner_is_owner) : _cardInner;
}

function filterPastes(type) {
    _pastesFilter = type;
    _pastesOffset = 0;
    document.querySelectorAll('.pastes-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === type));
    fetchPastes();
}

function setPastesUserFilter(username = 'all') {
    const next = String(username || 'all').trim() || 'all';
    if (next === _pastesUser) return;
    _pastesUser = next;
    _pastesOffset = 0;
    fetchPastes();
    const top = document.getElementById('page-pastes');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function searchPastes() {
    const input = document.getElementById('pastes-search-input');
    _pastesSearch = input?.value?.trim() || '';
    _pastesOffset = 0;
    fetchPastes();
}

function pastesPaginate(offset) {
    _pastesOffset = Math.max(0, offset);
    fetchPastes();
    document.getElementById('page-pastes')?.scrollTo(0, 0);
}

function pastesSort(sort) {
    const s = sort === 'oldest' ? 'oldest' : 'newest';
    if (s === _pastesSort) return;
    _pastesSort = s;
    _pastesOffset = 0;
    fetchPastes();
}

// ── View single paste ───────────────────────────────────────
async function loadPasteViewer(slug) {
    const container = document.getElementById('paste-viewer-content');
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    try {
        const data = await api(`/pastes/${slug}`);
        const p = data.paste;
        if (!p) throw new Error('Not found');
        if (typeof setPageTitle === 'function' && p.title) setPageTitle(p.title);

        // Check burn after read
        if (p.burned || (p.burn_after_read && p.views > 1)) {
            container.innerHTML = `
                <div class="paste-burned">
                    <i class="fa-solid fa-fire" style="font-size:3rem; color:var(--danger); margin-bottom:16px;"></i>
                    <h2>This paste has been burned</h2>
                    <p>It was set to self-destruct after being read.</p>
                    <button class="btn btn-primary" onclick="navigate('/pastes')">Back to Pastes</button>
                </div>`;
            return;
        }

        // NSFW interstitial — show warning unless user has already dismissed it
        const nsfwDismissed = sessionStorage.getItem('nsfw-ok-' + p.slug);
        if (p.is_nsfw && !nsfwDismissed) {
            container.innerHTML = `
                <div class="paste-nsfw-gate">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:3rem; color:var(--warning, #f39c12); margin-bottom:16px;"></i>
                    <h2>NSFW Content</h2>
                    <p>This paste has been marked as containing content that may not be suitable for all audiences.</p>
                    <div style="display:flex;gap:12px;margin-top:16px;">
                        <button class="btn btn-outline" onclick="navigate('/pastes')">Go Back</button>
                        <button class="btn btn-primary" id="nsfw-continue-btn">Continue</button>
                    </div>
                </div>`;
            document.getElementById('nsfw-continue-btn').addEventListener('click', () => {
                sessionStorage.setItem('nsfw-ok-' + p.slug, '1');
                renderPasteView(slug); // re-render without gate
            });
            return;
        }

        const isScreenshot = p.type === 'screenshot';
        const author = p.username || 'Anonymous';
        const isOwner = typeof currentUser !== 'undefined' && currentUser && p.user_id === currentUser.id;
        const isAdmin = typeof currentUser !== 'undefined' && currentUser && (currentUser.role === 'admin' || currentUser.role === 'global_mod');
        const isLoggedIn = typeof currentUser !== 'undefined' && !!currentUser;
        const userLiked = !!p.liked;
        const paste_id_for_js = p.id;

        let meta;
        try { meta = JSON.parse(p.metadata); } catch { meta = {}; }

        // AI "crazy moment" pastes carry a link back to the exact VOD timestamp they were
        // grabbed from — surface it as a real button (and drop the raw "▶ Watch…" line the
        // description text used to carry).
        const momentLink = (meta.ai_moment && typeof meta.vod_link === 'string' && /^\/(vod|clip)\//.test(meta.vod_link))
            ? `<a class="btn btn-primary btn-sm paste-moment-link" href="${escapeHtml(meta.vod_link)}" onclick="return handleLinkClick(event, '${escapeHtml(meta.vod_link)}')"><i class="fa-solid fa-circle-play"></i> Watch this moment on the VOD</a>`
            : '';
        const displayContent = (p.content || '').replace(/\n*▶[^\n]*$/,'').trim();

        let contentHtml;
        if (isScreenshot) {
            const screenshotUrl = p.screenshot_url || `/data/pastes/screenshots/${p.screenshot_path?.split('/').pop()}`;
            contentHtml = `
                <div class="paste-screenshot-view">
                    <img src="${escapeHtml(screenshotUrl)}" alt="Screenshot" class="paste-screenshot-img"
                         onclick="window.open(this.src, '_blank')">
                    ${displayContent ? `<div class="paste-screenshot-desc">${escapeHtml(displayContent)}</div>` : ''}
                    ${momentLink ? `<div class="paste-moment-link-row">${momentLink}</div>` : ''}
                    ${meta.page_url && /^https?:\/\//i.test(meta.page_url) ? `<div class="paste-screenshot-url"><i class="fa-solid fa-link"></i> <a href="${escapeHtml(meta.page_url)}" target="_blank" rel="noopener">${escapeHtml(meta.page_url)}</a></div>` : ''}
                    ${isLoggedIn ? `<div class="paste-screenshot-actions"><button class="btn btn-outline btn-sm" onclick="setPasteAsAvatar('${p.slug}')" title="Use this image as your avatar"><i class="fa-solid fa-user-circle"></i> Set As Avatar</button></div>` : ''}
                </div>`;
        } else {
            const lines = (p.content || '').split('\n');
            const lineNums = lines.map((_, i) => `<span>${i + 1}</span>`).join('\n');
            const highlighted = highlightSyntax(p.content || '', p.language || 'text');
            contentHtml = `
                <div class="paste-code-view">
                    <div class="paste-code-header">
                        <span class="paste-code-lang"><i class="fa-solid fa-code"></i> ${escapeHtml(p.language || 'text')}</span>
                        <span class="paste-code-lines">${lines.length} line${lines.length !== 1 ? 's' : ''}</span>
                        <div class="paste-code-actions">
                            <button class="btn btn-outline btn-sm" onclick="copyPasteContent()" title="Copy"><i class="fa-solid fa-copy"></i> Copy</button>
                            <a class="btn btn-outline btn-sm" href="/api/pastes/${p.slug}/raw" target="_blank" title="Raw"><i class="fa-solid fa-file-lines"></i> Raw</a>
                            <button class="btn btn-outline btn-sm" onclick="forkPaste('${p.slug}')" title="Fork"><i class="fa-solid fa-code-fork"></i> Fork</button>
                        </div>
                    </div>
                    <div class="paste-code-body">
                        <div class="paste-line-numbers">${lineNums}</div>
                        <pre class="paste-code-pre"><code id="paste-code-content">${highlighted}</code></pre>
                    </div>
                </div>`;
        }

        const forkedFrom = p.forked_from ? `<span class="paste-forked-badge"><i class="fa-solid fa-code-fork"></i> Forked</span>` : '';

        let _aiTags = [];
        try { _aiTags = p.ai_tags ? JSON.parse(p.ai_tags) : []; } catch { _aiTags = []; }
        const aiHtml = p.ai_summary ? `
            <div class="paste-ai-analysis">
                <div class="paste-ai-title"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Analysis</div>
                <div class="paste-ai-summary">${escapeHtml(p.ai_summary)}</div>
                ${_aiTags.length ? `<div class="paste-ai-tags">${_aiTags.map(t => `<span class="paste-ai-tag">${escapeHtml(String(t))}</span>`).join('')}</div>` : ''}
            </div>` : '';

        container.innerHTML = `
            <div class="paste-view-header">
                <div class="paste-view-title-row">
                    <h1 class="paste-view-title" id="paste-view-title">${escapeHtml(p.title)}${forkedFrom}</h1>
                    ${isAdmin ? `<button class="btn btn-outline btn-xs" onclick="renamePaste('${p.slug}')" title="Rename"><i class="fa-solid fa-pencil"></i></button>` : ''}
                    ${p.pinned ? '<span class="paste-card-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}
                    ${p.burn_after_read ? '<span class="paste-card-burn"><i class="fa-solid fa-fire"></i> Burns after read</span>' : ''}
                    ${p.is_nsfw ? '<span class="paste-card-nsfw">NSFW</span>' : ''}
                    ${p.visibility === 'unlisted' ? '<span class="paste-unlisted-badge"><i class="fa-solid fa-eye-slash"></i> Unlisted</span>' : ''}
                </div>
                <div class="paste-view-meta">
                    <span><i class="fa-solid fa-user"></i> ${escapeHtml(author)}</span>
                    <span><i class="fa-solid fa-clock"></i> ${formatTimeAgo(p.created_at)}</span>
                    <span><i class="fa-solid fa-eye"></i> ${p.views} view${p.views !== 1 ? 's' : ''}</span>
                    <span><i class="fa-solid fa-copy"></i> ${p.copies || 0} cop${(p.copies || 0) !== 1 ? 'ies' : 'y'}</span>
                    <button class="paste-like-btn ${userLiked ? 'liked' : ''}" id="paste-like-btn"
                        onclick="togglePasteLike('${p.slug}')" title="${isLoggedIn ? (userLiked ? 'Unlike' : 'Like') : 'Log in to like'}">
                        <i class="fa-solid fa-thumbs-up"></i> <span id="paste-like-count">${p.likes || 0}</span>
                    </button>
                    ${isOwner || isAdmin ? `
                        <div class="paste-view-owner-actions">
                            ${!isScreenshot ? `<button class="btn btn-outline btn-sm" onclick="editPaste('${p.slug}')"><i class="fa-solid fa-pen"></i> Edit</button>` : ''}
                            ${isScreenshot && isAdmin ? `<button class="btn btn-outline btn-sm" onclick="openImageCensor('${p.slug}')"><i class="fa-solid fa-mask"></i> Censor</button>` : ''}
                            <button class="btn btn-outline btn-sm btn-danger" onclick="deletePaste('${p.slug}')"><i class="fa-solid fa-trash"></i> Delete</button>
                        </div>
                    ` : ''}
                </div>
            </div>
            ${aiHtml}
            ${contentHtml}

            <div class="paste-comments-section" id="paste-comments-section">
                <div class="paste-comments-header">
                    <h3><i class="fa-solid fa-comments"></i> Comments <span id="paste-comment-count"></span></h3>
                </div>
                <div class="paste-comment-form" id="paste-comment-form">
                    ${isLoggedIn ? `
                        <div class="paste-comment-form-inner">
                            <div class="comment-avatar" style="background:${escapeHtml(currentUser.profile_color || '#8b5cf6')}">${(currentUser.username || '?')[0].toUpperCase()}</div>
                            <input type="text" id="paste-comment-input" placeholder="Write a comment..." maxlength="2000"
                                   onkeydown="if(event.key==='Enter')postPasteComment('${p.slug}', ${paste_id_for_js})">
                            <button class="btn btn-primary btn-sm" onclick="postPasteComment('${p.slug}', ${paste_id_for_js})">Post</button>
                        </div>
                    ` : `
                        <div class="paste-comment-form-inner paste-comment-anon-form">
                            <div class="comment-avatar" style="background:#666">?</div>
                            <input type="text" id="paste-comment-anon-name" placeholder="Name (optional)" maxlength="32" style="max-width:140px">
                            <input type="text" id="paste-comment-input" placeholder="Write a comment..." maxlength="2000"
                                   onkeydown="if(event.key==='Enter')postPasteComment('${p.slug}', ${paste_id_for_js})">
                            <button class="btn btn-primary btn-sm" onclick="postPasteComment('${p.slug}', ${paste_id_for_js})">Post</button>
                        </div>
                    `}
                </div>
                <div id="paste-comments-list"></div>
            </div>
        `;

        // Store content for clipboard
        container._pasteContent = p.content || '';
        container._pasteSlug = p.slug;

        // Load comments
        loadPasteComments(p.slug, paste_id_for_js, p.user_id);
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state" style="text-align:center; padding:48px;">
                <i class="fa-solid fa-circle-exclamation" style="font-size:2rem; color:var(--danger); margin-bottom:12px;"></i>
                <h3>Paste not found</h3>
                <p>It may have been deleted or the link is invalid.</p>
                <button class="btn btn-primary" onclick="navigate('/pastes')" style="margin-top:16px;">Browse Pastes</button>
            </div>`;
    }
}

function copyPasteContent() {
    const container = document.getElementById('paste-viewer-content');
    const text = container?._pasteContent || '';
    const slug = container?._pasteSlug || '';
    navigator.clipboard.writeText(text).then(() => {
        toast('Copied to clipboard!', 'success');
        // Track copy on server
        if (slug) {
            api(`/pastes/${slug}/copy`, { method: 'POST' }).catch(() => {});
        }
    }).catch(() => toast('Failed to copy', 'error'));
}

async function togglePasteLike(slug) {
    if (typeof currentUser === 'undefined' || !currentUser) {
        return toast('Log in to like pastes', 'error');
    }
    try {
        const data = await api(`/pastes/${slug}/like`, { method: 'POST' });
        const btn = document.getElementById('paste-like-btn');
        const countEl = document.getElementById('paste-like-count');
        if (btn) btn.classList.toggle('liked', data.liked);
        if (countEl) countEl.textContent = data.likes;
    } catch (err) {
        toast(err.message || 'Failed to like', 'error');
    }
}

async function forkPaste(slug) {
    try {
        const data = await api(`/pastes/${slug}/fork`, { method: 'POST' });
        toast('Paste forked!', 'success');
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        toast(err.message || 'Failed to fork', 'error');
    }
}

// Use an existing image paste as the current user's avatar.
async function setPasteAsAvatar(slug) {
    if (typeof currentUser === 'undefined' || !currentUser) { toast('Log in to set an avatar', 'error'); return; }
    try {
        const data = await api(`/pastes/${slug}/set-avatar`, { method: 'POST' });
        if (data.avatar_url) currentUser.avatar_url = data.avatar_url;
        toast('Avatar updated', 'success');
        if (typeof onAuthChange === 'function') onAuthChange();
    } catch (err) {
        toast(err.message || 'Failed to set avatar', 'error');
    }
}

async function deletePaste(slug) {
    if (!confirm('Delete this paste permanently?')) return;
    try {
        await api(`/pastes/${slug}`, { method: 'DELETE' });
        toast('Paste deleted', 'success');
        navigate('/pastes');
    } catch (err) {
        toast(err.message || 'Failed to delete', 'error');
    }
}

// ── Admin inline title rename ───────────────────────────────
async function renamePaste(slug) {
    const titleEl = document.getElementById('paste-view-title');
    if (!titleEl) return;
    const currentTitle = titleEl.textContent.trim();
    const newTitle = prompt('Rename paste:', currentTitle);
    if (newTitle === null || newTitle.trim() === '' || newTitle.trim() === currentTitle) return;
    try {
        const data = await api(`/pastes/${slug}`, {
            method: 'PUT',
            body: { title: newTitle.trim() },
        });
        toast('Title updated', 'success');
        titleEl.textContent = data.paste?.title || newTitle.trim();
    } catch (err) {
        toast(err.message || 'Failed to rename', 'error');
    }
}

// ═════════════════════════════════════════════════════════════
// ── Paste Comments ──────────────────────────────────────────
// ═════════════════════════════════════════════════════════════

// Current paste context for comments (set by loadPasteComments)
let _pasteCommentCtx = {};

async function loadPasteComments(slug, pasteId, pasteOwnerId) {
    _pasteCommentCtx = { slug, pasteId, pasteOwnerId };

    const countEl = document.getElementById('paste-comment-count');
    const listEl = document.getElementById('paste-comments-list');
    if (!listEl) return;

    try {
        const data = await api(`/pastes/${slug}/comments`);
        const comments = data.comments || [];
        const total = data.total || 0;

        if (countEl) countEl.textContent = total > 0 ? `(${total})` : '';

        if (!comments.length) {
            listEl.innerHTML = '<div class="comments-empty"><i class="fa-solid fa-comment-dots" style="font-size:1.5rem;margin-bottom:8px"></i><p>No comments yet. Be the first!</p></div>';
            return;
        }

        listEl.innerHTML = comments.map(c => renderPasteComment(c)).join('');
    } catch (e) {
        listEl.innerHTML = '<p class="muted">Failed to load comments</p>';
    }
}

function renderPasteComment(c) {
    const isAnon = !c.user_id;
    const name = isAnon ? (c.anon_name || 'Anonymous') : (c.display_name || c.username || 'Unknown');
    const initial = name[0].toUpperCase();
    const color = isAnon ? '#666' : (c.profile_color || '#8b5cf6');
    const edited = c.updated_at && c.updated_at !== c.created_at;

    const isLoggedIn = typeof currentUser !== 'undefined' && !!currentUser;
    const isOwnComment = isLoggedIn && c.user_id && c.user_id === currentUser.id;
    const isPasteOwner = isLoggedIn && _pasteCommentCtx.pasteOwnerId && currentUser.id === _pasteCommentCtx.pasteOwnerId;
    const isAdmin = isLoggedIn && (currentUser.role === 'admin' || currentUser.role === 'global_mod' || currentUser.capabilities?.moderate_global);

    let actionsHtml = '';
    // Reply button — anyone can reply (logged-in users or anon)
    if (!c.parent_id) {
        actionsHtml += `<button onclick="showPasteReplyForm(${c.id})"><i class="fa-solid fa-reply"></i> Reply</button>`;
    }
    // Delete — comment author, paste owner, or admin
    if (isOwnComment || isPasteOwner || isAdmin) {
        actionsHtml += `<button onclick="deletePasteComment(${c.id})"><i class="fa-solid fa-trash"></i> Delete</button>`;
    }

    let repliesHtml = '';
    if (c.replies && c.replies.length) {
        repliesHtml = `<div class="comment-replies">${c.replies.map(r => renderPasteComment(r)).join('')}</div>`;
    }

    const anonBadge = isAnon ? '<span class="badge" style="font-size:0.65rem;padding:1px 4px;background:#555;margin-left:4px">ANON</span>' : '';
    const adminBadge = !isAnon && c.role === 'admin' ? '<span class="badge" style="font-size:0.7rem;padding:1px 5px">ADMIN</span>' : '';
    const avatarHtml = !isAnon && c.avatar_url
        ? `<img src="${escapeHtml(c.avatar_url)}" class="comment-avatar" style="width:32px;height:32px;border-radius:50%;object-fit:cover" alt="">`
        : `<div class="comment-avatar" style="background:${escapeHtml(color)}">${initial}</div>`;

    return `
        <div class="comment-item" id="paste-comment-${c.id}">
            ${avatarHtml}
            <div class="comment-body">
                <div class="comment-meta">
                    <span class="comment-author" style="color:${escapeHtml(color)}">${escapeHtml(name)}</span>${anonBadge}${adminBadge}
                    <span class="comment-date">${formatTimeAgo(c.created_at)}${edited ? ' (edited)' : ''}</span>
                </div>
                <div class="comment-text">${escapeHtml(c.message)}</div>
                <div class="comment-actions">${actionsHtml}</div>
                <div id="paste-reply-form-${c.id}"></div>
                ${repliesHtml}
            </div>
        </div>`;
}

async function postPasteComment(slug, pasteId) {
    const input = document.getElementById('paste-comment-input');
    if (!input) return;

    const message = input.value.trim();
    if (!message) return toast('Write a comment first', 'error');

    const body = { message };

    // Include anon_name if not logged in
    const isLoggedIn = typeof currentUser !== 'undefined' && !!currentUser;
    if (!isLoggedIn) {
        const nameInput = document.getElementById('paste-comment-anon-name');
        if (nameInput) body.anon_name = nameInput.value.trim();
    }

    try {
        await api(`/pastes/${slug}/comments`, {
            method: 'POST',
            body,
        });
        input.value = '';
        toast('Comment posted', 'success');
        loadPasteComments(slug, pasteId, _pasteCommentCtx.pasteOwnerId);
    } catch (e) {
        toast(e.message || 'Failed to post comment', 'error');
    }
}

function showPasteReplyForm(parentId) {
    const container = document.getElementById(`paste-reply-form-${parentId}`);
    if (!container) return;

    // Toggle off if already open
    if (container.innerHTML) {
        container.innerHTML = '';
        return;
    }

    const isLoggedIn = typeof currentUser !== 'undefined' && !!currentUser;
    const slug = _pasteCommentCtx.slug;

    container.innerHTML = `
        <div class="reply-form">
            ${!isLoggedIn ? `<input type="text" id="paste-reply-anon-name-${parentId}" placeholder="Name" maxlength="32" style="max-width:100px">` : ''}
            <input type="text" id="paste-reply-input-${parentId}" placeholder="Write a reply..." maxlength="2000"
                   onkeydown="if(event.key==='Enter')postPasteReply(${parentId})">
            <button class="btn btn-small btn-primary" onclick="postPasteReply(${parentId})">Reply</button>
        </div>`;
    document.getElementById(`paste-reply-input-${parentId}`)?.focus();
}

async function postPasteReply(parentId) {
    const input = document.getElementById(`paste-reply-input-${parentId}`);
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    const slug = _pasteCommentCtx.slug;
    const body = { message, parent_id: parentId };

    const isLoggedIn = typeof currentUser !== 'undefined' && !!currentUser;
    if (!isLoggedIn) {
        const nameInput = document.getElementById(`paste-reply-anon-name-${parentId}`);
        if (nameInput) body.anon_name = nameInput.value.trim();
    }

    try {
        await api(`/pastes/${slug}/comments`, {
            method: 'POST',
            body,
        });
        toast('Reply posted', 'success');
        loadPasteComments(slug, _pasteCommentCtx.pasteId, _pasteCommentCtx.pasteOwnerId);
    } catch (e) {
        toast(e.message || 'Failed to post reply', 'error');
    }
}

async function deletePasteComment(commentId) {
    if (!confirm('Delete this comment?')) return;
    const slug = _pasteCommentCtx.slug;

    try {
        await api(`/pastes/${slug}/comments/${commentId}`, { method: 'DELETE' });
        toast('Comment deleted', 'success');
        loadPasteComments(slug, _pasteCommentCtx.pasteId, _pasteCommentCtx.pasteOwnerId);
    } catch (e) {
        toast(e.message || 'Failed to delete comment', 'error');
    }
}

// ── Admin image censoring ───────────────────────────────────
let _censorState = null;

function openImageCensor(slug) {
    // Find the screenshot image in the viewer
    const img = document.querySelector('.paste-screenshot-img');
    if (!img) return toast('No image found to censor', 'error');

    // Create a fullscreen censor overlay
    const overlay = document.createElement('div');
    overlay.id = 'image-censor-overlay';
    overlay.className = 'image-censor-overlay';
    overlay.innerHTML = `
        <div class="image-censor-toolbar">
            <div class="image-censor-tools">
                <button class="btn btn-sm image-censor-tool active" data-tool="rect" onclick="_setCensorTool('rect')" title="Black Rectangle">
                    <i class="fa-solid fa-square"></i> Black Box
                </button>
                <button class="btn btn-sm image-censor-tool" data-tool="blur" onclick="_setCensorTool('blur')" title="Blur Region">
                    <i class="fa-solid fa-droplet"></i> Blur
                </button>
                <button class="btn btn-sm image-censor-tool" data-tool="pixelate" onclick="_setCensorTool('pixelate')" title="Pixelate Region">
                    <i class="fa-solid fa-th"></i> Pixelate
                </button>
            </div>
            <div class="image-censor-actions">
                <button class="btn btn-sm btn-outline" onclick="_undoCensor()" title="Undo last"><i class="fa-solid fa-undo"></i> Undo</button>
                <button class="btn btn-sm btn-outline" onclick="_clearCensors()" title="Clear all"><i class="fa-solid fa-eraser"></i> Clear</button>
                <button class="btn btn-sm btn-outline" onclick="closeImageCensor()"><i class="fa-solid fa-times"></i> Cancel</button>
                <button class="btn btn-sm btn-primary" onclick="_saveCensoredImage('${slug}')"><i class="fa-solid fa-save"></i> Save</button>
            </div>
        </div>
        <div class="image-censor-canvas-wrap">
            <canvas id="censor-canvas"></canvas>
        </div>
    `;
    document.body.appendChild(overlay);

    // Load image into canvas
    const canvas = document.getElementById('censor-canvas');
    const ctx = canvas.getContext('2d');
    const srcImg = new Image();
    srcImg.crossOrigin = 'anonymous';
    srcImg.onload = () => {
        // Scale to fit viewport while maintaining aspect ratio
        const maxW = window.innerWidth - 40;
        const maxH = window.innerHeight - 80;
        let w = srcImg.naturalWidth;
        let h = srcImg.naturalHeight;
        const scale = Math.min(1, maxW / w, maxH / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        canvas.width = srcImg.naturalWidth;
        canvas.height = srcImg.naturalHeight;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.drawImage(srcImg, 0, 0);

        _censorState = {
            canvas, ctx, srcImg, slug,
            scaleX: srcImg.naturalWidth / w,
            scaleY: srcImg.naturalHeight / h,
            tool: 'rect',
            regions: [],
            drawing: false,
            startX: 0, startY: 0,
        };

        // Attach mouse/touch handlers
        canvas.addEventListener('mousedown', _censorMouseDown);
        canvas.addEventListener('mousemove', _censorMouseMove);
        canvas.addEventListener('mouseup', _censorMouseUp);
        canvas.addEventListener('touchstart', _censorTouchStart, { passive: false });
        canvas.addEventListener('touchmove', _censorTouchMove, { passive: false });
        canvas.addEventListener('touchend', _censorTouchEnd);
    };
    srcImg.src = img.src;
}

function closeImageCensor() {
    const overlay = document.getElementById('image-censor-overlay');
    if (overlay) overlay.remove();
    _censorState = null;
}

function _setCensorTool(tool) {
    if (_censorState) _censorState.tool = tool;
    document.querySelectorAll('.image-censor-tool').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === tool));
}

function _censorMouseDown(e) {
    if (!_censorState) return;
    const rect = _censorState.canvas.getBoundingClientRect();
    _censorState.drawing = true;
    _censorState.startX = (e.clientX - rect.left) * _censorState.scaleX;
    _censorState.startY = (e.clientY - rect.top) * _censorState.scaleY;
}

function _censorMouseMove(e) {
    if (!_censorState?.drawing) return;
    const rect = _censorState.canvas.getBoundingClientRect();
    const curX = (e.clientX - rect.left) * _censorState.scaleX;
    const curY = (e.clientY - rect.top) * _censorState.scaleY;
    _redrawCensor(curX, curY);
}

function _censorMouseUp(e) {
    if (!_censorState?.drawing) return;
    const rect = _censorState.canvas.getBoundingClientRect();
    const endX = (e.clientX - rect.left) * _censorState.scaleX;
    const endY = (e.clientY - rect.top) * _censorState.scaleY;
    _finalizeCensorRegion(endX, endY);
}

function _censorTouchStart(e) {
    e.preventDefault();
    if (!_censorState || !e.touches.length) return;
    const t = e.touches[0];
    const rect = _censorState.canvas.getBoundingClientRect();
    _censorState.drawing = true;
    _censorState.startX = (t.clientX - rect.left) * _censorState.scaleX;
    _censorState.startY = (t.clientY - rect.top) * _censorState.scaleY;
}

function _censorTouchMove(e) {
    e.preventDefault();
    if (!_censorState?.drawing || !e.touches.length) return;
    const t = e.touches[0];
    const rect = _censorState.canvas.getBoundingClientRect();
    const curX = (t.clientX - rect.left) * _censorState.scaleX;
    const curY = (t.clientY - rect.top) * _censorState.scaleY;
    _redrawCensor(curX, curY);
}

function _censorTouchEnd(e) {
    if (!_censorState?.drawing) return;
    // Use the last known position from the most recent touchmove
    const ct = e.changedTouches?.[0];
    if (ct) {
        const rect = _censorState.canvas.getBoundingClientRect();
        const endX = (ct.clientX - rect.left) * _censorState.scaleX;
        const endY = (ct.clientY - rect.top) * _censorState.scaleY;
        _finalizeCensorRegion(endX, endY);
    } else {
        _censorState.drawing = false;
    }
}

function _redrawCensor(curX, curY) {
    const { ctx, srcImg, regions, startX, startY, tool } = _censorState;
    // Redraw original image
    ctx.drawImage(srcImg, 0, 0);
    // Draw all committed regions
    for (const r of regions) _applyCensorRegion(r);
    // Draw current in-progress region
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    if (w > 2 && h > 2) {
        _applyCensorRegion({ tool, x, y, w, h });
        // Draw selection outline
        ctx.strokeStyle = tool === 'rect' ? '#ff0000' : '#00aaff';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    }
}

function _finalizeCensorRegion(endX, endY) {
    const { startX, startY, tool } = _censorState;
    _censorState.drawing = false;
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);
    if (w > 4 && h > 4) {
        _censorState.regions.push({ tool, x, y, w, h });
    }
    // Full redraw with all committed regions
    const { ctx, srcImg, regions } = _censorState;
    ctx.drawImage(srcImg, 0, 0);
    for (const r of regions) _applyCensorRegion(r);
}

function _applyCensorRegion(r) {
    const { ctx, canvas } = _censorState;
    const { x, y, w, h, tool } = r;
    if (tool === 'rect') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, w, h);
    } else if (tool === 'blur') {
        // Simulate blur by drawing scaled-down then scaled-up
        const blurSize = 12;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.max(1, Math.round(w / blurSize));
        tempCanvas.height = Math.max(1, Math.round(h / blurSize));
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, x, y, w, h, 0, 0, tempCanvas.width, tempCanvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, w, h);
    } else if (tool === 'pixelate') {
        const pixelSize = 16;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.max(1, Math.round(w / pixelSize));
        tempCanvas.height = Math.max(1, Math.round(h / pixelSize));
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, x, y, w, h, 0, 0, tempCanvas.width, tempCanvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, w, h);
        ctx.imageSmoothingEnabled = true;
    }
}

function _undoCensor() {
    if (!_censorState?.regions.length) return;
    _censorState.regions.pop();
    const { ctx, srcImg, regions } = _censorState;
    ctx.drawImage(srcImg, 0, 0);
    for (const r of regions) _applyCensorRegion(r);
}

function _clearCensors() {
    if (!_censorState) return;
    _censorState.regions = [];
    const { ctx, srcImg } = _censorState;
    ctx.drawImage(srcImg, 0, 0);
}

async function _saveCensoredImage(slug) {
    if (!_censorState?.regions.length) {
        return toast('No censoring applied', 'error');
    }
    const { canvas } = _censorState;
    try {
        // Convert canvas to blob
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Failed to export image');

        const formData = new FormData();
        formData.append('screenshot', blob, 'censored.png');

        const token = localStorage.getItem('token');
        const res = await fetch(`${typeof API !== 'undefined' ? API : ''}/api/pastes/${slug}/censor`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save');

        toast('Image censored and saved', 'success');
        closeImageCensor();
        // Reload the paste viewer
        loadPasteViewer(slug);
    } catch (err) {
        toast(err.message || 'Failed to save censored image', 'error');
    }
}

function editPaste(slug) {
    // Load into the create form for editing
    navigate(`/pastes?edit=${slug}`);
}

// ── Create / New paste UI ───────────────────────────────────

/**
 * Fetch paste config (with level-based limit info) from the server.
 * Caches for 1 minute to avoid spamming on every modal open.
 */
async function _fetchPasteLimitInfo(force = false) {
    if (!force && _pasteLimitCache && (Date.now() - _pasteLimitCacheTime) < PASTE_LIMIT_CACHE_TTL) {
        return _pasteLimitCache;
    }
    try {
        const data = await api('/pastes/config');
        _pasteLimitCache = data;
        _pasteLimitCacheTime = Date.now();
        return data;
    } catch (err) {
        console.warn('[Pastes] Failed to fetch config:', err);
        return null;
    }
}

/**
 * Render a small daily-limit bar into the given container element.
 * Shows remaining count, tier label, and a narrow progress bar.
 */
function _renderLimitInfo(container, info) {
    if (!container || !info?.levelInfo) {
        if (container) container.innerHTML = '';
        return;
    }
    const li = info.levelInfo;
    const isUnlimited = li.remaining === null || li.remaining === Infinity || !Number.isFinite(li.remaining);
    const isAnon = li.totalLevel === 0 && !localStorage.getItem('token');
    const pct = isUnlimited ? 0 : Math.min(100, Math.round((li.usedToday / li.dailyLimit) * 100));
    const barColor = pct >= 90 ? 'var(--danger, #e74c3c)' : pct >= 70 ? 'var(--warning, #f39c12)' : 'var(--accent, #646cff)';

    let label;
    if (isUnlimited) {
        label = `<i class="fa-solid fa-infinity" style="font-size:0.7em;"></i> Unlimited (staff)`;
    } else if (isAnon) {
        label = `${li.remaining}/${li.dailyLimit} today · <a href="#" onclick="navigate('/login');return false" style="color:var(--accent);">Log in</a> for more`;
    } else {
        label = `${li.remaining}/${li.dailyLimit} today · ${li.tierLabel}`;
    }

    container.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-size:0.8rem;opacity:0.7;">
            <i class="fa-solid fa-gauge" style="font-size:0.75rem;"></i>
            <span>${label}</span>
            ${!isUnlimited ? `<div style="flex:1;max-width:80px;height:4px;background:var(--border, #333);border-radius:2px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px;transition:width 0.3s;"></div>
            </div>` : ''}
        </div>`;
}

function openNewPasteModal(prefill = {}) {
    const modal = document.getElementById('paste-create-modal');
    if (!modal) return;

    const isEdit = !!prefill.slug;
    document.getElementById('paste-create-title').value = prefill.title || '';
    document.getElementById('paste-create-content').value = prefill.content || '';
    document.getElementById('paste-create-lang').value = prefill.language || 'auto';
    document.getElementById('paste-create-visibility').value = prefill.visibility || 'public';
    document.getElementById('paste-create-burn').checked = !!prefill.burn;
    const nsfwEl = document.getElementById('paste-create-nsfw');
    if (nsfwEl) nsfwEl.checked = !!prefill.is_nsfw;
    document.getElementById('paste-create-slug').value = prefill.slug || ''; // For edits

    // Update modal title and submit button for edit mode
    const titleEl = document.getElementById('paste-modal-title');
    const submitBtn = document.getElementById('paste-submit-btn');
    if (titleEl) titleEl.innerHTML = isEdit
        ? '<i class="fa-solid fa-pen"></i> Edit Paste'
        : '<i class="fa-solid fa-paste"></i> New Paste';
    if (submitBtn) submitBtn.innerHTML = isEdit
        ? '<i class="fa-solid fa-save"></i> Save Changes'
        : '<i class="fa-solid fa-paper-plane"></i> Create Paste';

    modal.style.display = 'flex';
    document.getElementById('paste-create-content').focus();

    // Update line count
    _updatePasteLineCount();

    // Fetch and show daily limit info (non-blocking)
    if (!isEdit) {
        const limitEl = document.getElementById('paste-limit-info');
        if (limitEl) limitEl.innerHTML = '<span style="opacity:0.4;font-size:0.8rem;">Loading limit…</span>';
        _fetchPasteLimitInfo().then(info => _renderLimitInfo(limitEl, info));
    }
}

function closePasteModal() {
    const modal = document.getElementById('paste-create-modal');
    if (modal) modal.style.display = 'none';
}

function _updatePasteLineCount() {
    const ta = document.getElementById('paste-create-content');
    const counter = document.getElementById('paste-line-count');
    if (ta && counter) {
        const lines = (ta.value || '').split('\n').length;
        const chars = (ta.value || '').length;
        counter.textContent = `${lines} line${lines !== 1 ? 's' : ''} · ${chars.toLocaleString()} chars`;
    }
}

async function submitPaste() {
    const title = document.getElementById('paste-create-title').value.trim();
    const content = document.getElementById('paste-create-content').value;
    const language = document.getElementById('paste-create-lang').value;
    const visibility = document.getElementById('paste-create-visibility').value;
    const burn = document.getElementById('paste-create-burn').checked;
    const nsfwEl = document.getElementById('paste-create-nsfw');
    const is_nsfw = nsfwEl ? nsfwEl.checked : false;
    const editSlug = document.getElementById('paste-create-slug').value;

    if (!content.trim()) return toast('Content is required', 'error');

    // Client-side cooldown check
    if (!editSlug && _pastesCooldownUntil > Date.now()) {
        const wait = Math.ceil((_pastesCooldownUntil - Date.now()) / 1000);
        return toast(`Please wait ${wait}s before creating another paste`, 'error');
    }

    try {
        let data;
        if (editSlug) {
            data = await api(`/pastes/${editSlug}`, {
                method: 'PUT',
                body: { title, content, language, visibility },
            });
            toast('Paste updated!', 'success');
        } else {
            data = await api('/pastes', {
                method: 'POST',
                body: { title: title || 'Untitled', content, language, visibility, burn_after_read: burn, is_nsfw },
            });
            toast('Paste created!', 'success');
            // Set cooldown
            _pastesCooldownUntil = Date.now() + 30000; // 30s default; will be overridden by server response
            _pasteLimitCacheTime = 0; // invalidate limit cache after creation
        }
        closePasteModal();
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        // If server returns cooldown, use it
        if (err.cooldown) _pastesCooldownUntil = Date.now() + err.cooldown * 1000;
        toast(err.message || 'Failed to save paste', 'error');
    }
}

// ── Image upload (from pastes page button) ──────────────────
function openImageUpload() {
    _openScreenshotUploadDialog(null, { mode: 'upload' });
}

// ── Screenshot capture (from navbar button) ─────────────────
let _screenshotPending = false;

async function captureScreenshot() {
    if (_screenshotPending) return;
    _screenshotPending = true;
    // Open the dialog immediately with a capturing indicator so it never feels frozen.
    _openScreenshotUploadDialog(null, { mode: 'screenshot' });
    _setScreenshotCapturing(true);
    try {
        const blob = await _captureViewportToBlob();
        if (!blob) throw new Error('Capture failed');
        _applyScreenshotBlob(blob);
    } catch (err) {
        console.error('[Screenshot] Capture error:', err);
        // Leave the drop-zone / file-picker fallback visible.
    } finally {
        _setScreenshotCapturing(false);
        _screenshotPending = false;
    }
}

// Show/clear a "Capturing…" indicator in the screenshot dialog while we render.
function _setScreenshotCapturing(on) {
    const area = document.querySelector('#screenshot-upload-modal .screenshot-preview-area');
    const submit = document.getElementById('screenshot-submit-btn');
    if (submit) submit.disabled = !!on;
    const zone = document.getElementById('screenshot-upload-zone');
    if (!area) return;
    let el = document.getElementById('screenshot-capturing');
    if (on) {
        if (zone) zone.style.display = 'none';
        if (!el) {
            el = document.createElement('div');
            el.id = 'screenshot-capturing';
            el.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;padding:32px;color:var(--text-secondary);font-size:0.95rem';
            el.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing screenshot…';
            area.prepend(el);
        }
    } else {
        if (el) el.remove();
        // Only re-show the drop zone if we didn't end up with a preview image.
        const preview = document.getElementById('screenshot-preview');
        if (zone && !(preview && preview._blob)) zone.style.display = '';
    }
}

// Put a captured blob into the dialog's preview.
function _applyScreenshotBlob(blob) {
    const preview = document.getElementById('screenshot-preview');
    if (!preview || !blob) return;
    try { if (preview._objUrl) URL.revokeObjectURL(preview._objUrl); } catch { /* */ }
    const url = URL.createObjectURL(blob);
    preview._objUrl = url;
    preview.src = url;
    preview.style.display = 'block';
    preview._blob = blob;
    preview._fromCapture = true;
    const zone = document.getElementById('screenshot-upload-zone');
    if (zone) zone.style.display = 'none';
}

// Pick the dominant on-screen <video>/<canvas> (the player) for a fast, pixel-accurate
// capture. Only used when it clearly dominates the viewport, else we rasterize the DOM.
function _pickCaptureMedia() {
    let best = null, bestArea = 0;
    const vpArea = window.innerWidth * window.innerHeight;
    for (const el of document.querySelectorAll('video, canvas')) {
        const w = el.videoWidth || el.width, h = el.videoHeight || el.height;
        if (!w || !h) continue;
        if (el.tagName === 'VIDEO' && el.readyState < 2) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
    }
    // Require the media to dominate the view (i.e. it's the player, not a widget/bg).
    return (best && bestArea > vpArea * 0.15) ? best : null;
}

async function _captureViewportToBlob() {
    // Fast path: if a stream/VOD/clip player dominates the view, grab its actual
    // frame directly (instant, and html2canvas can't read <video>/<canvas> pixels).
    const media = _pickCaptureMedia();
    if (media) {
        try {
            const w = media.videoWidth || media.width;
            const h = media.videoHeight || media.height;
            if (w && h) {
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(media, 0, 0, w, h);
                const b = await new Promise(r => c.toBlob(r, 'image/png'));
                if (b) return b;
            }
        } catch (e) {
            // Cross-origin video taints the canvas — fall through to DOM rasterization.
            console.warn('[Screenshot] media capture unavailable, rasterizing DOM:', e.message);
        }
    }

    // Fallback: rasterize the visible page DOM. Load html2canvas on-demand (~44KB gz).
    if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load html2canvas'));
            document.head.appendChild(script);
        });
    }

    // Capture current visible page
    const activePage = document.querySelector('.page.active') || document.getElementById('app');
    const canvas = await html2canvas(activePage, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#0e0e10',
        scale: 1, // was devicePixelRatio — 1x is much faster and plenty for a screenshot
        useCORS: true,
        logging: false,
        ignoreElements: (el) => {
            // Ignore screenshot button itself, modals, tooltips
            return el.id === 'paste-create-modal' || el.id === 'screenshot-upload-modal'
                || el.classList?.contains('modal-overlay') || el.classList?.contains('toast-container');
        },
    });

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function _openScreenshotUploadDialog(blob, opts = {}) {
    const modal = document.getElementById('screenshot-upload-modal');
    if (!modal) return;

    const isScreenshot = opts.mode === 'screenshot';
    const preview = document.getElementById('screenshot-preview');
    const fileInput = document.getElementById('screenshot-file-input');
    const titleEl = document.getElementById('image-upload-modal-title');
    const pageUrlGroup = document.getElementById('screenshot-page-url-group');

    // Set modal title & icon based on mode
    if (titleEl) {
        titleEl.innerHTML = isScreenshot
            ? '<i class="fa-solid fa-camera"></i> Upload Screenshot'
            : '<i class="fa-solid fa-cloud-arrow-up"></i> Upload Image';
    }

    // Show/hide page URL field (only relevant for screenshots)
    if (pageUrlGroup) pageUrlGroup.style.display = isScreenshot ? '' : 'none';

    if (blob) {
        const url = URL.createObjectURL(blob);
        preview.src = url;
        preview.style.display = 'block';
        preview._blob = blob;
        preview._fromCapture = true;
    } else {
        preview.src = '';
        preview.style.display = 'none';
        preview._blob = null;
        preview._fromCapture = false;
    }

    // Pre-fill fields
    document.getElementById('screenshot-page-url').value = isScreenshot ? window.location.href : '';
    document.getElementById('screenshot-title').value = isScreenshot ? `Screenshot — ${document.title}` : '';
    document.getElementById('screenshot-desc').value = '';
    document.getElementById('screenshot-visibility').value = 'public';
    if (fileInput) fileInput.value = '';

    modal.style.display = 'flex';

    // Attach clipboard paste listener
    _attachScreenshotClipboardHandler();

    // Attach drag-drop handlers to upload zone
    _attachScreenshotDragDrop();

    // Fetch and show daily limit info (non-blocking)
    const limitEl = document.getElementById('screenshot-limit-info');
    if (limitEl) limitEl.innerHTML = '<span style="opacity:0.4;font-size:0.8rem;">Loading limit…</span>';
    _fetchPasteLimitInfo().then(info => _renderLimitInfo(limitEl, info));
}

/* ── Clipboard paste handler for image upload ── */
let _screenshotPasteHandler = null;

function _attachScreenshotClipboardHandler() {
    _detachScreenshotClipboardHandler();
    _screenshotPasteHandler = (e) => {
        const modal = document.getElementById('screenshot-upload-modal');
        if (!modal || modal.style.display === 'none') return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (!blob) continue;
                const preview = document.getElementById('screenshot-preview');
                if (preview) {
                    if (preview.src) URL.revokeObjectURL(preview.src);
                    preview.src = URL.createObjectURL(blob);
                    preview.style.display = 'block';
                    preview._blob = blob;
                    preview._fromCapture = false;
                }
                // Update upload zone to show "pasted" state
                const zone = document.getElementById('screenshot-upload-zone');
                if (zone) zone.style.display = 'none';
                toast('Image pasted from clipboard', 'success');
                return;
            }
        }
    };
    document.addEventListener('paste', _screenshotPasteHandler);
}

function _detachScreenshotClipboardHandler() {
    if (_screenshotPasteHandler) {
        document.removeEventListener('paste', _screenshotPasteHandler);
        _screenshotPasteHandler = null;
    }
}

/* ── Drag & drop handler for image upload zone ── */
function _attachScreenshotDragDrop() {
    const zone = document.getElementById('screenshot-upload-zone');
    if (!zone || zone._ddAttached) return;
    zone._ddAttached = true;

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (!file || !file.type.startsWith('image/')) {
            toast('Please drop an image file', 'error');
            return;
        }
        const preview = document.getElementById('screenshot-preview');
        if (preview) {
            if (preview.src) URL.revokeObjectURL(preview.src);
            preview.src = URL.createObjectURL(file);
            preview.style.display = 'block';
            preview._blob = file;
            preview._fromCapture = false;
        }
        zone.style.display = 'none';
    });
}

function closeScreenshotModal() {
    const modal = document.getElementById('screenshot-upload-modal');
    if (modal) modal.style.display = 'none';
    const preview = document.getElementById('screenshot-preview');
    if (preview?.src) { URL.revokeObjectURL(preview.src); preview.src = ''; }
    // Reset upload zone visibility
    const zone = document.getElementById('screenshot-upload-zone');
    if (zone) zone.style.display = '';
    _detachScreenshotClipboardHandler();
}

function onScreenshotFileSelect(input) {
    const file = input.files?.[0];
    if (!file) return;
    const preview = document.getElementById('screenshot-preview');
    if (preview) {
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(file);
        preview.style.display = 'block';
        preview._blob = file;
        preview._fromCapture = false;
    }
}

async function submitScreenshot() {
    const preview = document.getElementById('screenshot-preview');
    const fileInput = document.getElementById('screenshot-file-input');
    const title = document.getElementById('screenshot-title').value.trim();
    const desc = document.getElementById('screenshot-desc').value.trim();
    const visibility = document.getElementById('screenshot-visibility').value;
    const pageUrl = document.getElementById('screenshot-page-url').value.trim();

    let blob = preview?._blob;
    if (!blob && fileInput?.files?.[0]) blob = fileInput.files[0];
    if (!blob) return toast('No screenshot to upload', 'error');

    // Client-side cooldown check
    if (_pastesCooldownUntil > Date.now()) {
        const wait = Math.ceil((_pastesCooldownUntil - Date.now()) / 1000);
        return toast(`Please wait ${wait}s before uploading`, 'error');
    }

    const formData = new FormData();
    formData.append('screenshot', blob instanceof Blob ? blob : blob, blob.name || 'screenshot.png');
    formData.append('title', title || 'Screenshot');
    formData.append('description', desc);
    formData.append('visibility', visibility);
    formData.append('page_url', pageUrl);
    formData.append('user_agent', navigator.userAgent);

    const submitBtn = document.getElementById('screenshot-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…'; }

    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${typeof API !== 'undefined' ? API : ''}/api/pastes/screenshot`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        toast('Screenshot uploaded!', 'success');
        closeScreenshotModal();
        _pastesCooldownUntil = Date.now() + 30000;
        _pasteLimitCacheTime = 0; // invalidate limit cache after upload
        navigate(`/p/${data.paste.slug}`);
    } catch (err) {
        toast(err.message || 'Failed to upload screenshot', 'error');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload'; }
    }
}

// ── Chat integration: /paste command creates a quick paste from chat ──
function handlePasteFromChat(content, streamId) {
    // This creates a paste programmatically from a chat message
    return api('/pastes', {
        method: 'POST',
        body: {
            title: `Chat paste — ${new Date().toLocaleString()}`,
            content,
            language: 'auto',
            visibility: 'public',
            stream_id: streamId || null,
        },
    });
}

// ── Utility ─────────────────────────────────────────────────
function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr.includes('T') ? dateStr : dateStr + 'Z');
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return date.toLocaleDateString();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
