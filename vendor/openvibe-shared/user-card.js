// ═══════════════════════════════════════════════════════════════
// OpenVibe — User Card & Context Menu
// Right-click any username to see profile card, quick actions,
// linked services, name effects, and moderator tools.
// Usage: OpenVibeUserCard.init({ apiBase, token, currentUserId })
//        OpenVibeUserCard.attach(element, userId)
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    let _config = { apiBase: 'https://openvibe.network', token: null, currentUserId: null, currentRole: 'user' };
    let _cardEl = null;
    let _cache = new Map();

    function injectStyles() {
        if (document.getElementById('openvibe-usercard-styles')) return;
        const s = document.createElement('style');
        s.id = 'openvibe-usercard-styles';
        s.textContent = `
            @keyframes openvibe-card-in { from { transform: scale(.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            .openvibe-usercard-overlay { position: fixed; inset: 0; z-index: 99998; }
            .openvibe-usercard {
                position: fixed; z-index: 99999;
                width: 300px; background: var(--bg-card, #22222c);
                border: 1px solid var(--border, #333340); border-radius: 12px;
                box-shadow: var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.5));
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                color: var(--text-primary, #e0e0e0);
                animation: openvibe-card-in .2s ease; overflow: hidden;
            }
            .openvibe-usercard-banner {
                height: 60px; background: linear-gradient(135deg, var(--accent-dark, #a07840), var(--accent, #8b5cf6));
                position: relative;
            }
            .openvibe-usercard-avatar {
                width: 56px; height: 56px; border-radius: 50%;
                border: 3px solid var(--bg-card, #22222c);
                position: absolute; bottom: -28px; left: 16px;
                background: var(--bg-tertiary, #2a2a38);
                object-fit: cover;
            }
            .openvibe-usercard-body { padding: 36px 16px 12px; }
            .openvibe-usercard-name {
                font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 6px;
            }
            .openvibe-usercard-name .role-badge {
                font-size: 9px; padding: 2px 6px; border-radius: 3px;
                font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
            }
            .openvibe-usercard-name .role-admin { background: rgba(231,76,60,0.15); color: #e74c3c; }
            .openvibe-usercard-name .role-global_mod { background: rgba(46,204,113,0.15); color: #2ecc71; }
            .openvibe-usercard-name .role-streamer { background: rgba(155,89,182,0.15); color: #9b59b6; }
            .openvibe-usercard-username { font-size: 12px; color: var(--text-muted, #707080); margin-bottom: 8px; }
            .openvibe-usercard-bio { font-size: 12px; color: var(--text-secondary, #b0b0b8); line-height: 1.4; margin-bottom: 10px; max-height: 40px; overflow: hidden; }
            .openvibe-usercard-services { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
            .openvibe-usercard-services .svc {
                font-size: 10px; padding: 3px 8px; border-radius: 4px;
                background: var(--bg-tertiary, #2a2a38); color: var(--text-secondary, #b0b0b8);
                display: flex; align-items: center; gap: 4px;
            }
            .openvibe-usercard-services .svc .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success, #2ecc71); }
            .openvibe-usercard-divider { height: 1px; background: var(--border, #333340); margin: 8px -16px; }
            .openvibe-usercard-actions { display: flex; flex-direction: column; gap: 2px; }
            .openvibe-usercard-actions button {
                display: flex; align-items: center; gap: 8px;
                width: 100%; padding: 8px 12px; background: none;
                border: none; border-radius: 6px; color: var(--text-primary, #e0e0e0);
                font-size: 12px; cursor: pointer; text-align: left;
                transition: background .12s;
            }
            .openvibe-usercard-actions button:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-usercard-actions button.danger { color: var(--live-red, #e74c3c); }
            .openvibe-usercard-actions button .icon { font-size: 14px; width: 20px; text-align: center; }

            /* Name effects (CSS classes applied to usernames) */
            .openvibe-name-fx-rainbow { background: linear-gradient(90deg, #ff0000, #ff7700, #ffff00, #00ff00, #0000ff, #8b00ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; background-size: 200%; animation: openvibe-rainbow 3s linear infinite; }
            @keyframes openvibe-rainbow { to { background-position: 200% center; } }
            .openvibe-name-fx-glow { text-shadow: 0 0 8px currentColor, 0 0 16px currentColor; }
            .openvibe-name-fx-fire { text-shadow: 0 0 4px #ff6600, 0 -2px 8px #ff3300, 0 -4px 12px #cc0000; }
            .openvibe-name-fx-ice { text-shadow: 0 0 6px #00ccff, 0 0 12px #0088ff; color: #aaddff; }
            .openvibe-name-fx-gold { background: linear-gradient(180deg, #ffd700, #daa520, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-shadow: none; }
            .openvibe-name-fx-glitch { animation: openvibe-glitch .1s infinite; }
            @keyframes openvibe-glitch { 0%,100%{transform:none} 25%{transform:translate(-1px,1px)} 50%{transform:translate(1px,-1px)} 75%{transform:translate(-1px,-1px)} }
            .openvibe-name-fx-neon { color: #39ff14; text-shadow: 0 0 5px #39ff14, 0 0 10px #39ff14, 0 0 20px #39ff14; }
            .openvibe-name-fx-shadow { text-shadow: 2px 2px 0 rgba(0,0,0,0.5); }
        `;
        document.head.appendChild(s);
    }

    // ── Fetch User Data ──────────────────────────────────────
    async function fetchUser(userId) {
        if (_cache.has(userId)) return _cache.get(userId);
        try {
            const headers = {};
            if (_config.token) headers['Authorization'] = `Bearer ${_config.token}`;
            const res = await fetch(`${_config.apiBase}/api/users/${userId}/card`, { headers, credentials: 'include' });
            if (!res.ok) return null;
            const data = await res.json();
            _cache.set(userId, data);
            setTimeout(() => _cache.delete(userId), 120_000); // 2min cache
            return data;
        } catch { return null; }
    }

    // ── Render Card ──────────────────────────────────────────
    function renderCard(data, x, y) {
        closeCard();
        const user = data.user;
        const linked = data.linked_accounts || [];

        const roleBadge = user.role !== 'user'
            ? `<span class="role-badge role-${user.role}">${user.role.replace('_', ' ')}</span>` : '';

        const nameClass = data.name_effect ? `openvibe-name-fx-${data.name_effect}` : '';
        const nameColor = user.profile_color ? `color:${user.profile_color}` : '';

        const services = linked.map(l => {
            const icons = { openvibelive: '📡', openvibegames: '⚔️', openvibemaps: '🗺️' };
            return `<span class="svc"><span class="dot"></span>${icons[l.service] || '🔗'} ${l.service_username || l.service}</span>`;
        }).join('');

        const isSelf = _config.currentUserId && String(_config.currentUserId) === String(user.id);
        const isMod = ['admin', 'global_mod'].includes(_config.currentRole);

        let actions = '';
        if (!isSelf) {
            actions += `<button data-act="profile"><span class="icon">👤</span> View Profile</button>`;
            actions += `<button data-act="message"><span class="icon">💬</span> Send Message</button>`;
            actions += `<button data-act="follow"><span class="icon">➕</span> Follow</button>`;
            if (isMod) {
                actions += `<div class="openvibe-usercard-divider"></div>`;
                actions += `<button data-act="warn"><span class="icon">⚠️</span> Warn User</button>`;
                actions += `<button data-act="mute"><span class="icon">🔇</span> Mute</button>`;
                actions += `<button data-act="ban" class="danger"><span class="icon">🚫</span> Ban User</button>`;
            }
        } else {
            actions += `<button data-act="profile"><span class="icon">⚙️</span> Edit Profile</button>`;
            actions += `<button data-act="accounts"><span class="icon">🔄</span> Switch Account</button>`;
        }

        const card = document.createElement('div');
        card.className = 'openvibe-usercard';

        const avatarUrl = user.avatar_url || `${_config.apiBase}/data/avatars/default.png`;
        card.innerHTML = `
            <div class="openvibe-usercard-banner" style="${user.profile_color ? `background: linear-gradient(135deg, ${user.profile_color}88, ${user.profile_color})` : ''}"></div>
            <img class="openvibe-usercard-avatar" src="${avatarUrl}" alt="${user.username}" onerror="this.style.display='none'">
            <div class="openvibe-usercard-body">
                <div class="openvibe-usercard-name">
                    <span class="${nameClass}" style="${nameColor}">${user.display_name || user.username}</span>
                    ${roleBadge}
                </div>
                <div class="openvibe-usercard-username">@${user.username}${data.anon_number ? ` · Anon #${data.anon_number}` : ''}</div>
                ${user.bio ? `<div class="openvibe-usercard-bio">${user.bio}</div>` : ''}
                ${services ? `<div class="openvibe-usercard-services">${services}</div>` : ''}
                <div class="openvibe-usercard-divider"></div>
                <div class="openvibe-usercard-actions">${actions}</div>
            </div>
        `;

        // Position
        const vw = window.innerWidth, vh = window.innerHeight;
        card.style.left = Math.min(x, vw - 320) + 'px';
        card.style.top = Math.min(y, vh - 400) + 'px';

        // Overlay to close on click-outside
        const overlay = document.createElement('div');
        overlay.className = 'openvibe-usercard-overlay';
        overlay.addEventListener('click', closeCard);
        overlay.addEventListener('contextmenu', e => { e.preventDefault(); closeCard(); });

        document.body.appendChild(overlay);
        document.body.appendChild(card);
        _cardEl = { card, overlay };

        // Action handlers
        card.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                closeCard();
                if (act === 'profile') {
                    const url = isSelf ? `${_config.apiBase}/my`
                        : `${_config.apiBase}/user/${user.username}`;
                    window.open(url, '_blank');
                } else if (act === 'message') {
                    // Dispatch custom event for the host app to handle
                    document.dispatchEvent(new CustomEvent('openvibe-user-action', {
                        detail: { action: act, user }
                    }));
                } else {
                    document.dispatchEvent(new CustomEvent('openvibe-user-action', {
                        detail: { action: act, user }
                    }));
                }
            });
        });
    }

    function closeCard() {
        if (_cardEl) {
            _cardEl.card.remove();
            _cardEl.overlay.remove();
            _cardEl = null;
        }
    }

    // ── Public API ───────────────────────────────────────────
    const OpenVibeUserCard = {
        init(opts = {}) {
            Object.assign(_config, opts);
            injectStyles();
        },

        /** Attach right-click card to an element. */
        attach(el, userId) {
            el.style.cursor = 'pointer';
            el.addEventListener('contextmenu', async e => {
                e.preventDefault();
                const data = await fetchUser(userId);
                if (data) renderCard(data, e.clientX, e.clientY);
            });
            // Also support click on mobile
            el.addEventListener('click', async e => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const data = await fetchUser(userId);
                    if (data) renderCard(data, e.clientX, e.clientY);
                }
            });
        },

        /** Programmatically show a card at position. */
        async show(userId, x, y) {
            const data = await fetchUser(userId);
            if (data) renderCard(data, x, y);
        },

        close: closeCard,
        clearCache() { _cache.clear(); },

        /** Apply name effect CSS class to an element. */
        applyNameEffect(el, effectName) {
            if (!effectName) return;
            el.classList.add(`openvibe-name-fx-${effectName}`);
        },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeUserCard;
    else root.OpenVibeUserCard = OpenVibeUserCard;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
