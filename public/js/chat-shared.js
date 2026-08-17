/* ═══════════════════════════════════════════════════════════════════
   chat-shared.js — SINGLE SOURCE OF TRUTH for chat link handling +
   the user context menu, shared by BOTH the main SPA (index.html) and
   the standalone kiosk (/kiosk). Change it here → both update.

   Wrapped in an IIFE with its own `esc` so it never collides with the
   SPA's global `esc`/helpers. Everything the inline onclick="" handlers
   in chat message markup need is re-exported onto `window` at the end.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    /* ═══════════════════════════════════════════════════════════════
       CHAT LINKS — Trust-Domain System, Context Menu & Preview
       (moved verbatim from chat.js so the trusted-domain list + dialogs
       behave identically on the main site and the kiosk, sharing the
       same `openvibe_trusted_domains` localStorage entry.)
       ═══════════════════════════════════════════════════════════════ */
    const _TRUSTED_DOMAINS_KEY = 'openvibe_trusted_domains';
    let _trustedDomains = new Set();
    let _activeLinkMenu = null;
    let _activeLinkDialog = null;

    (function _initTrustedDomains() {
        try {
            const stored = localStorage.getItem(_TRUSTED_DOMAINS_KEY);
            if (stored) {
                const arr = JSON.parse(stored);
                if (Array.isArray(arr)) _trustedDomains = new Set(arr);
            }
        } catch { /* ignore */ }
    })();

    function _saveTrustedDomains() {
        try {
            localStorage.setItem(_TRUSTED_DOMAINS_KEY, JSON.stringify([..._trustedDomains]));
        } catch { /* ignore */ }
    }

    function _getDomain(url) {
        try { return new URL(url).hostname.toLowerCase(); }
        catch { return ''; }
    }

    function handleChatLinkClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const a = event.currentTarget || event.target.closest('.chat-link');
        if (!a) return;
        const url = a.dataset.url || a.href;
        if (!url) return;
        const domain = _getDomain(url);

        const alwaysTrusted = ['openvibe.live', 'www.openvibe.live', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
        }
        _showTrustDomainDialog(url, domain);
    }

    function _showTrustDomainDialog(url, domain) {
        _dismissLinkDialog();

        const overlay = document.createElement('div');
        overlay.className = 'link-trust-overlay show';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkDialog(); });

        overlay.innerHTML = `
            <div class="link-trust-dialog">
                <div class="link-trust-header">
                    <i class="fa-solid fa-shield-halved"></i>
                    <span>Trust This Domain?</span>
                </div>
                <div class="link-trust-body">
                    <p class="link-trust-warning">You're about to visit an external link. Make sure you trust this domain before proceeding.</p>
                    <div class="link-trust-domain">
                        <i class="fa-solid fa-globe"></i>
                        <span>${esc(domain)}</span>
                    </div>
                    <div class="link-trust-url-wrap">
                        <code class="link-trust-url">${esc(url)}</code>
                        <button class="link-trust-copy" title="Copy URL" onclick="event.stopPropagation(); _copyLinkUrl(this)">
                            <i class="fa-regular fa-copy"></i>
                        </button>
                    </div>
                </div>
                <div class="link-trust-actions">
                    <button class="link-trust-btn link-trust-cancel" onclick="_dismissLinkDialog()">Cancel</button>
                    <button class="link-trust-btn link-trust-once" onclick="_openLinkOnce('${esc(url)}')">Open Once</button>
                    <button class="link-trust-btn link-trust-always" onclick="_trustAndOpen('${esc(url)}', '${esc(domain)}')">
                        <i class="fa-solid fa-check"></i> Always Trust ${esc(domain)}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        _activeLinkDialog = overlay;

        const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkDialog(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    function _dismissLinkDialog() {
        if (_activeLinkDialog) {
            _activeLinkDialog.remove();
            _activeLinkDialog = null;
        }
    }

    function _copyLinkUrl(btn) {
        const code = btn.parentElement.querySelector('.link-trust-url');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(() => {
            const icon = btn.querySelector('i');
            if (icon) { icon.className = 'fa-solid fa-check'; setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500); }
        }).catch(() => { });
    }

    function _openLinkOnce(url) {
        _dismissLinkDialog();
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function _trustAndOpen(url, domain) {
        _trustedDomains.add(domain);
        _saveTrustedDomains();
        _dismissLinkDialog();
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function showLinkContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        _dismissLinkMenu();

        const a = event.currentTarget || event.target.closest('.chat-link');
        if (!a) return;
        const url = a.dataset.url || a.href;
        if (!url) return;

        const menu = document.createElement('div');
        menu.className = 'link-context-menu';
        menu.innerHTML = `
            <button class="link-ctx-btn" onclick="_linkCtxOpenTab('${esc(url)}')">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open in New Tab
            </button>
            <button class="link-ctx-btn" onclick="_linkCtxPreview('${esc(url)}')">
                <i class="fa-solid fa-eye"></i> Preview
            </button>
            <div class="link-ctx-divider"></div>
            <button class="link-ctx-btn" onclick="_linkCtxCopy('${esc(url)}', this)">
                <i class="fa-regular fa-copy"></i> Copy URL
            </button>
        `;

        document.body.appendChild(menu);
        _activeLinkMenu = menu;
        _positionLinkMenu(menu, event.clientX, event.clientY);

        setTimeout(() => {
            document.addEventListener('click', _dismissLinkMenu, { once: true });
        }, 10);
    }

    function _positionLinkMenu(menu, x, y) {
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (x + rect.width > vw - 8) menu.style.left = Math.max(8, x - rect.width) + 'px';
            if (y + rect.height > vh - 8) menu.style.top = Math.max(8, y - rect.height) + 'px';
        });
    }

    function _dismissLinkMenu() {
        if (_activeLinkMenu) {
            _activeLinkMenu.remove();
            _activeLinkMenu = null;
        }
    }

    function _linkCtxOpenTab(url) {
        _dismissLinkMenu();
        const domain = _getDomain(url);
        const alwaysTrusted = ['openvibe.live', 'www.openvibe.live', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            _showTrustDomainDialog(url, domain);
        }
    }

    function _linkCtxCopy(url, btn) {
        _dismissLinkMenu();
        navigator.clipboard.writeText(url).catch(() => { });
    }

    function _linkCtxPreview(url) {
        _dismissLinkMenu();
        _showLinkPreview(url);
    }

    function _showLinkPreview(url) {
        _dismissLinkPreview();

        const overlay = document.createElement('div');
        overlay.className = 'link-preview-overlay show';
        overlay.id = 'link-preview-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _dismissLinkPreview(); });

        overlay.innerHTML = `
            <div class="link-preview-modal">
                <div class="link-preview-header">
                    <div class="link-preview-url-bar">
                        <i class="fa-solid fa-globe"></i>
                        <span class="link-preview-url-text" title="${esc(url)}">${esc(url)}</span>
                        <button class="link-preview-copy" title="Copy URL" onclick="event.stopPropagation(); navigator.clipboard.writeText('${esc(url)}')">
                            <i class="fa-regular fa-copy"></i>
                        </button>
                    </div>
                    <div class="link-preview-toolbar">
                        <button class="link-preview-btn" title="Open in New Tab" onclick="_linkPreviewOpen('${esc(url)}')">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                        </button>
                        <button class="link-preview-btn link-preview-close" title="Close" onclick="_dismissLinkPreview()">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div class="link-preview-body">
                    <div class="link-preview-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading preview...
                    </div>
                    <iframe class="link-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" src="${esc(url)}" onload="this.previousElementSibling.style.display='none'" onerror="this.previousElementSibling.innerHTML='<i class=\\'fa-solid fa-triangle-exclamation\\'></i> Could not load preview'"></iframe>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const onKey = (e) => { if (e.key === 'Escape') { _dismissLinkPreview(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    function _dismissLinkPreview() {
        const el = document.getElementById('link-preview-overlay');
        if (el) el.remove();
    }

    function _linkPreviewOpen(url) {
        const domain = _getDomain(url);
        const alwaysTrusted = ['openvibe.live', 'www.openvibe.live', location.hostname];
        if (alwaysTrusted.includes(domain) || _trustedDomains.has(domain)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            _dismissLinkPreview();
            _showTrustDomainDialog(url, domain);
        }
    }

    /**
     * Turn plain text into safe HTML with clickable, trust-gated .chat-link anchors.
     * Produces the same anchor markup the SPA emits (emotes.js), so the shared trust
     * handlers wire up identically. URLs are escaped; everything else is escaped too.
     */
    const _URL_RE = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;!?)\]}'"])/gi;
    function linkify(text) {
        const raw = String(text ?? '');
        let out = '';
        let last = 0;
        raw.replace(_URL_RE, (match, _url, offset) => {
            out += esc(raw.slice(last, offset));
            const href = /^https?:\/\//i.test(match) ? match : 'https://' + match;
            const eh = esc(href);
            out += `<a class="chat-link" href="${eh}" data-url="${eh}" onclick="return handleChatLinkClick(event)" oncontextmenu="return showLinkContextMenu(event)" title="${eh}" rel="noopener noreferrer">${esc(match)}</a>`;
            last = offset + match.length;
            return match;
        });
        out += esc(raw.slice(last));
        return out;
    }

    // ── Re-export everything inline onclick="" handlers reference ──
    Object.assign(window, {
        handleChatLinkClick, showLinkContextMenu,
        _showTrustDomainDialog, _dismissLinkDialog, _copyLinkUrl, _openLinkOnce, _trustAndOpen,
        _positionLinkMenu, _dismissLinkMenu, _linkCtxOpenTab, _linkCtxCopy, _linkCtxPreview,
        _showLinkPreview, _dismissLinkPreview, _linkPreviewOpen,
    });

    /* ═══════════════════════════════════════════════════════════════
       USER CONTEXT MENU — shared markup builder.
       The SPA (chat.js) and the kiosk both render menus from this single
       source, so a change here updates both. Actions are invoked by global
       onclick names (ctxWhisper, ctxViewChannel, openUserChatInsight, …)
       which each environment provides; privileged buttons are gated by the
       injected `ctx` capabilities, so an anonymous kiosk viewer only ever
       sees the universal actions.
       ═══════════════════════════════════════════════════════════════ */
    function _badgeHTML(role) {
        switch (role) {
            case 'owner':
            case 'admin': return '<span class="chat-badge chat-badge-admin" data-tip="Staff - Admin"><i class="fa-solid fa-shield-halved"></i></span>';
            case 'global_mod': return '<span class="chat-badge chat-badge-mod" data-tip="Staff - Mod"><i class="fa-solid fa-shield"></i></span>';
            case 'streamer': return '<span class="chat-badge chat-badge-streamer" data-tip="Streamer"><i class="fa-solid fa-tower-broadcast"></i></span>';
            case 'mod':
            case 'moderator': return '<span class="chat-badge chat-badge-cmod" data-tip="Moderator"><i class="fa-solid fa-gavel"></i></span>';
            case 'subscriber': return '<span class="chat-badge chat-badge-sub" data-tip="Subscriber"><i class="fa-solid fa-star"></i></span>';
            default: return '';
        }
    }
    const _num = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); };

    // Relay usernames are stored like "[Kick] name" / "kick:name" — split platform + handle.
    const _RELAY_PLATFORMS = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', yt: 'YouTube', rs: 'RobotStreamer', robotstreamer: 'RobotStreamer' };
    function parseRelayUsername(raw) {
        const s = String(raw || '').trim();
        let m = s.match(/^\[([a-z]+)\]\s*(.+)$/i) || s.match(/^([a-z]+):(.+)$/i);
        if (m) {
            const p = m[1].toLowerCase();
            if (_RELAY_PLATFORMS[p]) return { platform: p === 'yt' ? 'youtube' : (p === 'robotstreamer' ? 'rs' : p), externalUsername: m[2].trim() };
        }
        return { platform: '', externalUsername: s };
    }
    // Platform → Font Awesome badge (brand icon where one exists, styled letter otherwise).
    function relayPlatformBadge(platform) {
        const p = String(platform || '').toLowerCase();
        const map = {
            twitch: '<i class="fa-brands fa-twitch"></i>',
            youtube: '<i class="fa-brands fa-youtube"></i>',
            kick: '<span class="relay-ico-txt">K</span>',
            rs: '<i class="fa-solid fa-robot"></i>',
        };
        const label = _RELAY_PLATFORMS[p] || (p ? p[0].toUpperCase() + p.slice(1) : 'Relay');
        const ico = map[p] || '<i class="fa-solid fa-link"></i>';
        return `<span class="chat-relay-badge relay-${esc(p)}" title="${esc(label)} chat">${ico}</span>`;
    }

    // ctx = { currentUser, chatStreamId, currentStreamData, canMod }
    // Returns the innerHTML for a `.chat-context-menu`. `d.kind` = user|relay|anon|system.
    function buildUserMenu(d) {
        const ctx = d.ctx || {};
        const cu = ctx.currentUser || null;
        const cap = (cu && cu.capabilities) || {};
        const canMod = !!(ctx.canMod && ctx.chatStreamId);
        const isGlobalMod = !!cap.moderate_global;
        const replyBtn = d.replyMsgId ? `<button class="ctx-btn" onclick="ctxReply()"><i class="fa-solid fa-reply"></i> Reply</button>` : '';

        if (d.kind === 'system') {
            return `
                <div class="ctx-header">
                    <span class="ctx-avatar-letter" style="background:var(--accent)"><i class="fa-solid fa-tower-broadcast"></i></span>
                    <div class="ctx-info">
                        <span class="ctx-name">${esc(d.username)}</span>
                        <span class="ctx-meta"><i class="fa-solid fa-circle-check"></i> Official system account</span>
                    </div>
                </div>
                <div class="ctx-actions">
                    <a class="ctx-btn" href="/updates" style="text-decoration:none" onclick="dismissContextMenu();return handleLinkClick(event, '/updates')"><i class="fa-solid fa-rss"></i> View all updates</a>
                    <div class="ctx-system-note">Automated site account — its posts are the changelog. It can't be messaged, moderated, or analyzed.</div>
                </div>`;
        }

        if (d.kind === 'relay') {
            const { platform, externalUsername } = (d.platform != null)
                ? { platform: d.platform, externalUsername: d.externalUsername }
                : parseRelayUsername(d.username);
            const displayPlatform = d.displayPlatform || (platform ? (_RELAY_PLATFORMS[platform] || (platform[0].toUpperCase() + platform.slice(1))) : 'Relay');
            const initial = externalUsername[0] ? externalUsername[0].toUpperCase() : '?';
            const colors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', rs: '#e67e22' };
            const color = colors[platform] || '#888';
            let modBtns = '';
            if (canMod || isGlobalMod) {
                if (d.msgId) modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(String(d.msgId))}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
                modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(d.username)}" onclick="ctxDeleteRelayMessages(this.dataset.username)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
                modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(d.username)}" onclick="ctxHideRelayUser(this.dataset.username)"><i class="fa-solid fa-eye-slash"></i> Hide from stream</button>`;
                modBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(d.username)}" onclick="ctxBanRelayUser(this.dataset.username)"><i class="fa-solid fa-ban"></i> Ban from stream</button>`;
                modBtns += `<button class="ctx-btn" data-username="${esc(d.username)}" onclick="ctxUnbanRelayUser(this.dataset.username)"><i class="fa-solid fa-rotate-left"></i> Unban / unhide</button>`;
            }
            return `
                <div class="ctx-header">
                    <span class="ctx-avatar-letter" style="background:${esc(color)}">${esc(initial)}</span>
                    <div class="ctx-info">
                        <span class="ctx-name">${esc(externalUsername)}</span>
                        <span class="ctx-meta"><i class="fa-solid fa-link"></i> ${esc(displayPlatform)} relay user</span>
                        <span class="ctx-meta ctx-relay-joined" style="opacity:0.85"><i class="fa-solid fa-clock"></i> …</span>
                    </div>
                </div>
                <div class="ctx-actions">
                    ${replyBtn}
                    <button class="ctx-btn" onclick="dismissContextMenu();window.openRelayUserChatInsight&&openRelayUserChatInsight('${esc(platform)}','${esc(externalUsername)}','${esc(displayPlatform)}')"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Insight</button>
                    ${cu && cu.id && ctx.currentStreamData && ctx.currentStreamData.user_id === cu.id ? `<button class="ctx-btn" onclick="dismissContextMenu();window.aivCloneChatter&&aivCloneChatter('relay','${esc(platform)}:${esc(externalUsername)}','${esc(externalUsername)}')"><i class="fa-solid fa-clone"></i> AI Clone</button>` : ''}
                    ${cap.view_all_logs ? `<button class="ctx-btn" onclick="dismissContextMenu();ctxViewRelayLogs('${esc(platform)}','${esc(externalUsername)}')"><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs</button>` : ''}
                    ${modBtns ? '<div class="ctx-divider"></div>' + modBtns : ''}
                </div>`;
        }

        if (d.kind === 'anon') {
            const username = d.username;
            const initial = username[0] ? username[0].toUpperCase() : '?';
            let modBtns = '';
            if (canMod || isGlobalMod) {
                if (d.msgId) modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(String(d.msgId))}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
                modBtns += `<button class="ctx-btn ctx-btn-warn" data-username="${esc(username)}" onclick="ctxDeleteAllAnonMessages(this.dataset.username)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
            }
            if (modBtns) modBtns = '<div class="ctx-divider"></div>' + modBtns;
            let banBtns = '';
            if (canMod || cap.manage_site_bans || cap.view_ip_info) banBtns += '<div class="ctx-divider"></div>';
            if (cap.view_ip_info) banBtns += `<button class="ctx-btn ctx-btn-admin-tools" data-username="${esc(username)}" data-uid="" data-anon="1" onclick="ctxAdminTools(this.dataset.username, null, this.dataset.username)"><i class="fa-solid fa-shield-halved"></i> Admin Tools</button>`;
            if (canMod) banBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(d.userId || '')}" onclick="ctxStreamBan(this.dataset.username, null, this.dataset.username)"><i class="fa-solid fa-comment-slash"></i> Ban from stream</button>`;
            if (cap.manage_site_bans) banBtns += `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(d.userId || '')}" onclick="ctxGlobalBanAnon(this.dataset.username)"><i class="fa-solid fa-ban"></i> Ban from site</button>`;
            return `
                <div class="ctx-header">
                    <span class="ctx-avatar-letter" style="background:#666">${esc(initial)}</span>
                    <div class="ctx-info">
                        <span class="ctx-name">${esc(username)}</span>
                        <span class="ctx-meta">Anonymous user</span>
                        <span class="ctx-meta ctx-anon-meta" style="opacity:0.85"><i class="fa-solid fa-clock"></i> …</span>
                    </div>
                </div>
                <div class="ctx-actions">
                    ${replyBtn}
                    <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
                    <button class="ctx-btn" data-username="${esc(username)}" onclick="dismissContextMenu();window.openAnonChatInsight&&openAnonChatInsight(this.dataset.username)"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Insight</button>
                    ${cap.view_all_logs ? `<button class="ctx-btn" data-username="${esc(username)}" onclick="dismissContextMenu();ctxViewAnonLogs(this.dataset.username)"><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs</button>` : ''}
                    ${modBtns}
                    ${banBtns}
                </div>`;
        }

        // kind === 'user' (registered)
        const p = d.profile || {};
        const username = d.username;
        const tAgo = (d.deps && d.deps.timeAgoShort) || ((x) => x || '?');
        const numf = (d.deps && d.deps.formatNumber) || _num;
        const avatarHtml = p.avatar_url
            ? `<img class="ctx-avatar" src="${esc(p.avatar_url)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''">`
            + `<span class="ctx-avatar-letter" style="display:none;background:${esc(p.profile_color || '#999')}">${esc(username[0] ? username[0].toUpperCase() : '?')}</span>`
            : `<span class="ctx-avatar-letter" style="background:${esc(p.profile_color || '#999')}">${esc(username[0] ? username[0].toUpperCase() : '?')}</span>`;
        const badge = _badgeHTML(p.role);
        const joined = p.created_at ? tAgo(p.created_at) : '?';
        let gameHtml = '';
        if (p.game) {
            const g = p.game;
            gameHtml = `
                <div class="ctx-game">
                    <div class="ctx-game-level">Lv. <strong>${esc(String(g.total_level))}</strong></div>
                    <div class="ctx-skills">
                        <span title="Mining ${esc(String(g.mining_level))}"><i class="fa-solid fa-gem"></i>${esc(String(g.mining_level))}</span>
                        <span title="Fishing ${esc(String(g.fishing_level))}"><i class="fa-solid fa-fish"></i>${esc(String(g.fishing_level))}</span>
                        <span title="Woodcutting ${esc(String(g.woodcut_level))}"><i class="fa-solid fa-tree"></i>${esc(String(g.woodcut_level))}</span>
                        <span title="Farming ${esc(String(g.farming_level))}"><i class="fa-solid fa-seedling"></i>${esc(String(g.farming_level))}</span>
                        <span title="Combat ${esc(String(g.combat_level))}"><i class="fa-solid fa-sword"></i>${esc(String(g.combat_level))}</span>
                        <span title="Crafting ${esc(String(g.crafting_level))}"><i class="fa-solid fa-hammer"></i>${esc(String(g.crafting_level))}</span>
                    </div>
                </div>`;
        }
        const coins = p.openvibe_coins_balance || 0;
        const msgs = p.messageCount || 0;
        let modBtns = '';
        if (canMod || isGlobalMod) {
            if (d.msgId) modBtns += `<button class="ctx-btn ctx-btn-warn" onclick="ctxDeleteMessage('${esc(String(d.msgId))}')"><i class="fa-solid fa-trash"></i> Delete Message</button>`;
            modBtns += `<button class="ctx-btn ctx-btn-warn" data-uid="${esc(String(p.id))}" onclick="ctxDeleteAllUserMessages(this.dataset.uid)"><i class="fa-solid fa-trash-can"></i> Delete All Messages</button>`;
        }
        return `
            <div class="ctx-header">
                ${avatarHtml}
                <div class="ctx-info">
                    <span class="ctx-name">${badge}${esc(p.display_name || username)}</span>
                    <span class="ctx-meta">@${esc(username)} &middot; ${joined}</span>
                </div>
            </div>
            <div class="ctx-stats">
                <div class="ctx-stat"><i class="fa-solid fa-coins"></i> ${numf(coins)}</div>
                <div class="ctx-stat"><i class="fa-solid fa-message"></i> ${numf(msgs)}</div>
                <div class="ctx-stat"><i class="fa-solid fa-heart"></i> ${numf(p.followerCount || 0)}</div>
            </div>
            ${gameHtml}
            <div class="ctx-divider"></div>
            <div class="ctx-actions">
                ${replyBtn}
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxWhisper(this.dataset.username)"><i class="fa-solid fa-comment"></i> Message</button>
                ${cu && cu.id && cu.id !== p.id ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxCallUser(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-phone"></i> Call this user</button>` : ''}
                <button class="ctx-btn" data-username="${esc(username)}" onclick="ctxViewChannel(this.dataset.username)"><i class="fa-solid fa-user"></i> Channel</button>
                ${p.id ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="dismissContextMenu();window.openUserChatInsight&&openUserChatInsight(this.dataset.uid, this.dataset.username)"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Insight</button>` : ''}
                ${p.id && cu && cu.id && ctx.currentStreamData && ctx.currentStreamData.user_id === cu.id ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="dismissContextMenu();window.aivCloneChatter&&aivCloneChatter('user', this.dataset.uid, this.dataset.username)"><i class="fa-solid fa-clone"></i> AI Clone</button>` : ''}
                ${cap.view_all_logs ? `<button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxViewLogs(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-clock-rotate-left"></i> Chat Logs</button>` : ''}
                ${cap.manage_users ? `<div class="ctx-rename-group">
                    <button class="ctx-btn" onclick="this.parentElement.classList.toggle('open')" type="button"><i class="fa-solid fa-pen"></i> Rename <i class="fa-solid fa-chevron-right ctx-rename-arrow"></i></button>
                    <div class="ctx-rename-submenu">
                        <button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxRenameUsername(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-at"></i> Rename Username</button>
                        <button class="ctx-btn" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" data-display="${esc(p.display_name || username)}" onclick="ctxRenameDisplayName(this.dataset.username, this.dataset.uid, this.dataset.display)"><i class="fa-solid fa-signature"></i> Rename Display Name</button>
                    </div>
                </div>` : ''}
                ${modBtns ? '<div class="ctx-divider"></div>' + modBtns : ''}
                ${canMod || cap.manage_site_bans || cap.view_ip_info ? '<div class="ctx-divider"></div>' : ''}
                ${cap.view_ip_info ? `<button class="ctx-btn ctx-btn-admin-tools" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxAdminTools(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-shield-halved"></i> Admin Tools</button>` : ''}
                ${canMod ? `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxStreamBan(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-comment-slash"></i> Ban from stream</button>` : ''}
                ${cap.manage_site_bans ? `<button class="ctx-btn ctx-btn-danger" data-username="${esc(username)}" data-uid="${esc(String(p.id))}" onclick="ctxGlobalBan(this.dataset.username, this.dataset.uid)"><i class="fa-solid fa-ban"></i> Ban from site</button>` : ''}
            </div>`;
    }

    /* ═══════════════════════════════════════════════════════════════
       TTS link/username helpers — shared so chat.js, broadcast.js (and a
       mirror in the server tts-engine) all decide "is this actually a link?"
       the same way, instead of reading "sent a link to i" for typos like
       "I.gkt" whose ".gkt" isn't a real TLD.
       ═══════════════════════════════════════════════════════════════ */
    // Common gTLDs; every 2-letter TLD is accepted as a country code.
    const _TTS_TLDS = new Set('com net org io co gg tv me app dev xyz info biz live tech online site store blog news wiki gov edu mil int tools quest link click stream fm to ly gl sh cc ws pro club shop art design games game media cloud email fun life world today space website host page video chat social band lol wtf social space money space'.split(/\s+/));
    function _realTld(tld) { tld = String(tld || '').toLowerCase(); return tld.length === 2 || _TTS_TLDS.has(tld); }
    // Shorten a username for speech: collapse long same-character runs ("WWWW…" → "W") and cap length.
    function ttsUsername(name) {
        if (!name) return name;
        let n = String(name).replace(/(.)\1{3,}/g, '$1');
        if (n.length > 18) n = n.slice(0, 18);
        return n;
    }
    // Replace only REAL links with a spoken description; leave non-link text (typos) untouched.
    function ttsReplaceLinks(text, username) {
        const uname = ttsUsername(username);
        return String(text == null ? '' : text).replace(
            /((?:https?:\/\/)?(?:www\.)?)([a-z0-9][-a-z0-9]*(?:\.[a-z]{2,})+)([^\s]*)/gi,
            (m, pre, domain) => {
                const hasScheme = /https?:\/\//i.test(pre) || /^www\./i.test(pre);
                const parts = domain.split('.');
                if (!hasScheme && !_realTld(parts[parts.length - 1])) return m; // not a real link → keep as text
                const site = parts.length > 2 ? parts[parts.length - 2] : parts[0];
                return uname ? `(${uname} sent a link to ${site})` : `(link to ${site})`;
            }
        );
    }

    window.OpenVibeChat = {
        escape: esc,
        linkify,
        ttsReplaceLinks,
        ttsUsername,
        handleLinkClick: handleChatLinkClick,
        showLinkContextMenu,
        isTrusted: (domain) => _trustedDomains.has(String(domain || '').toLowerCase()),
        buildUserMenu,
        parseRelayUsername,
        relayPlatformBadge,
        badgeHTML: _badgeHTML,
    };
})();
