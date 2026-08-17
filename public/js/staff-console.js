const STAFF_TAB_DEFS = [
    { id: 'overview', label: 'Overview', icon: 'fa-chart-pie' },
    { id: 'chat', label: 'Chat Logs', icon: 'fa-comments' },
    { id: 'streams', label: 'Streams', icon: 'fa-video' },
    { id: 'bans', label: 'Bans', icon: 'fa-ban' },
    { id: 'actions', label: 'Audit Log', icon: 'fa-list-check' },
    { id: 'canvas', label: 'Canvas', icon: 'fa-brush' },
    { id: 'users', label: 'Users', icon: 'fa-users', adminOnly: true },
    { id: 'global-mods', label: 'Global Mods', icon: 'fa-shield-halved', adminOnly: true },
    { id: 'settings', label: 'Settings', icon: 'fa-sliders', adminOnly: true },
    { id: 'verification', label: 'Verification', icon: 'fa-key', adminOnly: true },
    { id: 'cashouts', label: 'Cashouts', icon: 'fa-money-bill-transfer', adminOnly: true },
    { id: 'vpn', label: 'VPN Queue', icon: 'fa-network-wired', adminOnly: true },
];

const LEGACY_ADMIN_TAB_LOADERS = {
    users: () => typeof loadAdminUsers === 'function' && loadAdminUsers(),
    'global-mods': () => typeof loadAdminModerators === 'function' && loadAdminModerators(),
    settings: () => typeof loadAdminSettings === 'function' && loadAdminSettings(),
    verification: () => typeof loadAdminVerificationKeys === 'function' && loadAdminVerificationKeys(),
    cashouts: () => typeof loadAdminCashouts === 'function' && loadAdminCashouts(),
    vpn: () => typeof loadAdminVPN === 'function' && loadAdminVPN(),
};

let staffLogsOffset = 0;
let staffLogsQuery = '';
let staffLogsUserId = '';
let staffCanvasCache = null;

function getStaffCaps() {
    return getUserCapabilities(currentUser);
}

function isAdminStaffUser() {
    return hasCapability('can_manage_users');
}

function getStaffRoleLabel() {
    const role = getStaffCaps().staff_role;
    if (role === 'admin') return 'Administrator';
    if (role === 'global_mod') return 'Global Moderator';
    return 'Staff';
}

function getAllowedStaffTabs() {
    return STAFF_TAB_DEFS.filter((tab) => !tab.adminOnly || isAdminStaffUser());
}

function normalizeStaffTab(tab) {
    const aliases = {
        moderators: 'global-mods',
        'chat-logs': 'chat',
    };
    return aliases[tab] || tab;
}

function getDefaultStaffTab() {
    const tabs = getAllowedStaffTabs();
    return tabs[0]?.id || 'overview';
}

function ensureAllowedStaffTab(tab) {
    const normalized = normalizeStaffTab(tab);
    return getAllowedStaffTabs().some((item) => item.id === normalized) ? normalized : getDefaultStaffTab();
}

function formatStaffDate(value) {
    if (!value) return '-';
    const normalized = value.includes('T') || value.endsWith('Z')
        ? value
        : value.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function summarizeModAction(action) {
    const details = action.details || {};
    const pieces = [];
    if (details.reason) pieces.push(esc(details.reason));
    if (details.username) pieces.push(`user ${esc(details.username)}`);
    if (details.count) pieces.push(`${details.count} tiles`);
    if (details.stream_id) pieces.push(`stream #${details.stream_id}`);
    if (details.channel_id) pieces.push(`channel #${details.channel_id}`);
    return pieces.join(' - ') || 'No details';
}

function toIsoFromInput(value) {
    return value ? new Date(value).toISOString() : null;
}

async function resolveUsernameToUserId(username) {
    const profile = await api(`/chat/user/${encodeURIComponent(username)}/profile`);
    return profile?.id || null;
}

function renderStaffTabs() {
    const tabsContainer = document.querySelector('#page-admin .admin-tabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = getAllowedStaffTabs().map((tab) => `
        <button class="tab-btn ${currentAdminTab === tab.id ? 'active' : ''}" onclick="switchAdminTab('${tab.id}')">
            <i class="fa-solid ${tab.icon}"></i> ${tab.label}
        </button>
    `).join('');
}

async function loadStaffStats() {
    const container = document.getElementById('admin-stats');
    if (!container) return;
    container.innerHTML = '<p class="muted">Loading staff stats...</p>';

    try {
        const [modData, adminData] = await Promise.all([
            api('/mod/stats'),
            isAdminStaffUser() ? api('/admin/stats') : Promise.resolve(null),
        ]);

        const modStats = modData?.stats || {};
        const adminStats = adminData || {};
        const cards = [];

        if (isAdminStaffUser()) {
            cards.push(
                { label: 'Total Users', value: adminStats.users?.total || 0, icon: 'fa-users' },
                { label: 'Live Streams', value: adminStats.streams?.live || 0, icon: 'fa-broadcast-tower' },
                { label: 'Pending Cashouts', value: adminStats.openvibeBucks?.pendingCashouts || 0, icon: 'fa-money-bill-transfer' },
                { label: 'Active Bans', value: modStats.activeBans || 0, icon: 'fa-ban' },
                { label: 'Chat Messages', value: modStats.totalMessages || 0, icon: 'fa-comments' },
                { label: 'Channel Actions', value: modStats.channelActions || 0, icon: 'fa-gavel' }
            );
        } else {
            cards.push(
                { label: 'Live Streams', value: modStats.liveStreams || 0, icon: 'fa-broadcast-tower' },
                { label: 'Active Bans', value: modStats.activeBans || 0, icon: 'fa-ban' },
                { label: 'Chat Messages', value: modStats.totalMessages || 0, icon: 'fa-comments' },
                { label: 'Channel Actions', value: modStats.channelActions || 0, icon: 'fa-gavel' }
            );
        }

        cards.unshift({
            label: 'Your Role',
            value: getStaffRoleLabel(),
            icon: 'fa-id-badge',
        });

        container.innerHTML = cards.map((stat) => `
            <div class="admin-stat">
                <div class="admin-stat-value">${typeof stat.value === 'number' ? stat.value.toLocaleString() : esc(stat.value)}</div>
                <div class="admin-stat-label"><i class="fa-solid ${stat.icon}"></i> ${stat.label}</div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<p class="muted">Failed to load staff stats.</p>';
    }
}

async function loadStaffOverview() {
    const content = document.getElementById('admin-content');
    const caps = getStaffCaps();
    const items = [
        caps.can_moderate_site_chat && 'Search cross-site chat logs and inspect user history.',
        caps.can_manage_canvas && 'Moderate the collaborative canvas with rollbacks, locks, bans, and snapshots.',
        caps.can_manage_users && 'Manage users, global moderators, verification keys, cashouts, and site settings.',
        caps.can_manage_channels && 'Channel moderation lives in the streamer dashboard for owners and channel mods.',
    ].filter(Boolean);

    content.innerHTML = `
        <div class="staff-panel-grid">
            <div class="staff-panel-card">
                <h3><i class="fa-solid fa-handshake-angle"></i> Staff Access</h3>
                <p class="muted">Signed in as <strong>${esc(getStaffRoleLabel())}</strong>.</p>
                <div class="staff-chip-row">
                    <span class="staff-chip ${caps.can_manage_canvas ? 'is-live' : ''}">Canvas Tools</span>
                    <span class="staff-chip ${caps.can_moderate_site_chat ? 'is-live' : ''}">Site Chat</span>
                    <span class="staff-chip ${caps.can_manage_users ? 'is-live' : ''}">Admin Controls</span>
                </div>
            </div>
            <div class="staff-panel-card">
                <h3><i class="fa-solid fa-route"></i> What Lives Where</h3>
                <div class="staff-note-list">
                    ${items.map((item) => `<div class="staff-note"><i class="fa-solid fa-check"></i> ${item}</div>`).join('')}
                </div>
            </div>
            <div class="staff-panel-card">
                <h3><i class="fa-solid fa-brush"></i> Canvas Policy</h3>
                <div class="staff-note-list">
                    <div class="staff-note"><i class="fa-solid fa-lock"></i> Logged-in users place tiles.</div>
                    <div class="staff-note"><i class="fa-solid fa-hourglass-half"></i> Cooldowns scale with OpenVibeGame total level.</div>
                    <div class="staff-note"><i class="fa-solid fa-shield-halved"></i> Region locks, read-only mode, rollbacks, and user overrides are live staff tools.</div>
                </div>
            </div>
        </div>
    `;
}

async function loadStaffChatLogs() {
    const content = document.getElementById('admin-content');
    content.innerHTML = `
        <div class="staff-toolbar">
            <input type="text" id="staff-log-search" class="form-input" placeholder="Search messages..." value="${esc(staffLogsQuery)}" onkeydown="if(event.key==='Enter')staffSearchLogs()">
            <input type="text" id="staff-log-userid" class="form-input staff-toolbar-small" placeholder="User ID (optional)" value="${esc(staffLogsUserId)}" onkeydown="if(event.key==='Enter')staffSearchLogs()">
            <button class="btn btn-primary" onclick="staffSearchLogs()"><i class="fa-solid fa-search"></i> Search</button>
        </div>
        <div id="staff-logs-results"><p class="muted">Search site-wide chat logs by message text or user ID.</p></div>
        <div id="staff-logs-pager" class="staff-pager"></div>
    `;
}

async function fetchStaffLogs() {
    const results = document.getElementById('staff-logs-results');
    const pager = document.getElementById('staff-logs-pager');
    if (!results) return;
    results.innerHTML = '<p class="muted">Loading logs...</p>';

    try {
        const params = new URLSearchParams({ limit: '50', offset: String(staffLogsOffset) });
        if (staffLogsQuery) params.set('q', staffLogsQuery);
        if (staffLogsUserId) params.set('user_id', staffLogsUserId);
        const data = await api(`/mod/chat/search?${params}`);
        const messages = data.messages || [];
        const total = data.total || 0;

        if (!messages.length) {
            results.innerHTML = '<p class="muted">No messages matched that search.</p>';
            if (pager) pager.innerHTML = '';
            return;
        }

        results.innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr><th>Time</th><th>User</th><th>Message</th><th>Stream</th></tr>
                </thead>
                <tbody>
                    ${messages.map((message) => `
                        <tr>
                            <td>${formatStaffDate(message.timestamp)}</td>
                            <td>
                                <button class="staff-link-btn" onclick="staffOpenLogsForUser(${message.user_id || 0}, '${esc(message.display_name || message.username || 'Anonymous')}')">
                                    ${esc(message.display_name || message.username || 'Anonymous')}
                                </button>
                            </td>
                            <td>${esc(message.message || '')}</td>
                            <td>${message.stream_id || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        const pages = Math.ceil(total / 50);
        const currentPageNumber = Math.floor(staffLogsOffset / 50) + 1;
        pager.innerHTML = pages > 1 ? `
            <button class="btn btn-small" ${staffLogsOffset <= 0 ? 'disabled' : ''} onclick="staffLogsPrev()"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="muted">Page ${currentPageNumber} of ${pages} (${total} results)</span>
            <button class="btn btn-small" ${currentPageNumber >= pages ? 'disabled' : ''} onclick="staffLogsNext()"><i class="fa-solid fa-chevron-right"></i></button>
        ` : `<span class="muted">${total} results</span>`;
    } catch (err) {
        results.innerHTML = `<p class="muted">Failed to load logs: ${esc(err.message || 'Unknown error')}</p>`;
        if (pager) pager.innerHTML = '';
    }
}

async function loadStaffStreams() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<p class="muted">Loading live streams...</p>';

    try {
        const data = await api('/mod/streams');
        const streams = data.streams || [];
        if (!streams.length) {
            content.innerHTML = '<p class="muted">No live streams right now.</p>';
            return;
        }

        content.innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr><th>Title</th><th>Streamer</th><th>Protocol</th><th>Viewers</th><th>Started</th><th>Actions</th></tr>
                </thead>
                <tbody>
                    ${streams.map((stream) => `
                        <tr>
                            <td>${esc(stream.title || 'Untitled')}</td>
                            <td>${esc(stream.display_name || stream.username || '-')}</td>
                            <td>${esc((stream.protocol || 'webrtc').toUpperCase())}</td>
                            <td>${Number(stream.viewer_count || 0).toLocaleString()}</td>
                            <td>${formatStaffDate(stream.started_at)}</td>
                            <td>
                                <button class="btn btn-small btn-danger" onclick="staffForceEndStream('${stream.id}')">
                                    <i class="fa-solid fa-stop"></i> End
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        content.innerHTML = `<p class="muted">Failed to load streams: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

async function loadStaffBans() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<p class="muted">Loading bans...</p>';

    try {
        const data = await api('/mod/bans');
        const bans = data.bans || [];
        content.innerHTML = `
            <div class="staff-panel-grid">
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-user-slash"></i> Create Site Ban</h3>
                    <div class="staff-form-grid">
                        <input type="text" id="staff-ban-username" class="form-input" placeholder="Username">
                        <input type="number" id="staff-ban-duration" class="form-input" placeholder="Duration hours (0 = permanent)" min="0" step="1">
                        <textarea id="staff-ban-reason" class="form-input staff-form-wide" rows="3" placeholder="Reason"></textarea>
                    </div>
                    <button class="btn btn-primary" onclick="staffCreateSiteBan()"><i class="fa-solid fa-ban"></i> Ban User</button>
                </div>
                <div class="staff-panel-card staff-panel-card-wide">
                    <h3><i class="fa-solid fa-list"></i> Active Bans</h3>
                    ${bans.length ? `
                        <table class="admin-table">
                            <thead>
                                <tr><th>User</th><th>Reason</th><th>By</th><th>Expires</th><th>Actions</th></tr>
                            </thead>
                            <tbody>
                                ${bans.map((ban) => `
                                    <tr>
                                        <td>${esc(ban.display_name || ban.username || ban.banned_username || ban.user_id)}</td>
                                        <td>${esc(ban.reason || '-')}</td>
                                        <td>${esc(ban.banned_by_username || '-')}</td>
                                        <td>${ban.expires_at ? formatStaffDate(ban.expires_at) : 'Permanent'}</td>
                                        <td>
                                            <button class="btn btn-small" onclick="staffUnbanUser(${ban.user_id})"><i class="fa-solid fa-user-check"></i> Unban</button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    ` : '<p class="muted">No active bans.</p>'}
                </div>
            </div>
        `;
    } catch (err) {
        content.innerHTML = `<p class="muted">Failed to load bans: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

async function loadStaffActions() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<p class="muted">Loading moderation actions...</p>';

    try {
        const data = await api('/mod/actions?limit=100');
        const actions = data.actions || [];
        content.innerHTML = actions.length ? `
            <table class="admin-table">
                <thead>
                    <tr><th>Time</th><th>Scope</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr>
                </thead>
                <tbody>
                    ${actions.map((action) => `
                        <tr>
                            <td>${formatStaffDate(action.created_at)}</td>
                            <td>${esc(action.scope_type || 'site')}${action.scope_id ? ` #${action.scope_id}` : ''}</td>
                            <td>${esc(action.action_type || '-')}</td>
                            <td>${esc(action.actor_username || '-')}</td>
                            <td>${esc(action.target_username || '-')}</td>
                            <td>${summarizeModAction(action)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        ` : '<p class="muted">No moderation actions logged yet.</p>';
    } catch (err) {
        content.innerHTML = `<p class="muted">Failed to load moderation actions: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

function renderCanvasHeatmap(heatmap) {
    const buckets = heatmap?.buckets || [];
    const users = heatmap?.users || [];
    const ips = heatmap?.ips || [];
    return `
        <div class="staff-mini-grid">
            <div class="staff-mini-card">
                <h4>Hot Regions</h4>
                ${buckets.length ? buckets.map((bucket) => `<div class="staff-mini-row">(${bucket.bucket_x}, ${bucket.bucket_y}) <strong>${bucket.placements}</strong></div>`).join('') : '<p class="muted">No heatmap data.</p>'}
            </div>
            <div class="staff-mini-card">
                <h4>Top Users</h4>
                ${users.length ? users.map((user) => `<div class="staff-mini-row">${esc(user.username || `User ${user.user_id || '?'}`)} <strong>${user.placements}</strong></div>`).join('') : '<p class="muted">No user data.</p>'}
            </div>
            <div class="staff-mini-card">
                <h4>Top IPs</h4>
                ${ips.length ? ips.map((ip) => `<div class="staff-mini-row">${esc(ip.ip_address || 'Unknown')} <strong>${ip.placements}</strong></div>`).join('') : '<p class="muted">No IP data.</p>'}
            </div>
        </div>
    `;
}

async function loadStaffCanvas() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<p class="muted">Loading canvas tools...</p>';

    try {
        const requests = [
            api('/game/canvas/state'),
            api('/game/canvas/staff/actions?limit=80'),
            api('/game/canvas/staff/bans'),
            api('/game/canvas/staff/regions'),
            api('/game/canvas/staff/snapshots'),
            api('/game/canvas/staff/heatmap?hours=12'),
        ];
        if (hasCapability('can_manage_canvas_settings')) {
            requests.push(api('/game/canvas/admin/overrides'));
            requests.push(api('/game/canvas/admin/settings'));
        }

        const response = await Promise.all(requests);
        const state = response[0];
        const actions = response[1];
        const bans = response[2];
        const regions = response[3];
        const snapshots = response[4];
        const heatmap = response[5];
        const overrides = hasCapability('can_manage_canvas_settings') ? response[6] : { overrides: [] };
        const settings = hasCapability('can_manage_canvas_settings') ? response[7] : { settings: state.board };

        staffCanvasCache = {
            state,
            actions: actions.actions || [],
            bans: bans.bans || [],
            regions: regions.regions || [],
            snapshots: snapshots.snapshots || [],
            heatmap,
            overrides: overrides.overrides || [],
            settings: settings.settings || {},
        };

        const boardState = state.settings || {};
        const board = state.board || {};
        const currentSettings = staffCanvasCache.settings;

        content.innerHTML = `
            <div class="staff-panel-grid">
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-chess-board"></i> Board Status</h3>
                    <div class="staff-note-list">
                        <div class="staff-note"><i class="fa-solid fa-expand"></i> ${board.width || 0} x ${board.height || 0}</div>
                        <div class="staff-note"><i class="fa-solid fa-fill-drip"></i> ${state.tiles?.length || 0} painted tiles</div>
                        <div class="staff-note"><i class="fa-solid fa-lock"></i> Read only: <strong>${boardState.read_only ? 'Yes' : 'No'}</strong></div>
                        <div class="staff-note"><i class="fa-solid fa-snowflake"></i> Frozen: <strong>${boardState.frozen ? 'Yes' : 'No'}</strong></div>
                        <div class="staff-note"><i class="fa-solid fa-stopwatch"></i> Tile overwrite lock: <strong>${boardState.tile_cooldown_seconds || 20}s</strong></div>
                    </div>
                </div>
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-rotate-left"></i> Rollback</h3>
                    <div class="staff-form-grid">
                        <select id="canvas-rollback-mode" class="form-input">
                            <option value="tile">Single tile</option>
                            <option value="user">By user</option>
                            <option value="region">Rectangle</option>
                            <option value="time_range">Time range</option>
                        </select>
                        <input type="number" id="canvas-rollback-x" class="form-input" placeholder="X">
                        <input type="number" id="canvas-rollback-y" class="form-input" placeholder="Y">
                        <input type="number" id="canvas-rollback-user" class="form-input" placeholder="User ID">
                        <input type="number" id="canvas-rollback-x1" class="form-input" placeholder="X1">
                        <input type="number" id="canvas-rollback-y1" class="form-input" placeholder="Y1">
                        <input type="number" id="canvas-rollback-x2" class="form-input" placeholder="X2">
                        <input type="number" id="canvas-rollback-y2" class="form-input" placeholder="Y2">
                        <input type="datetime-local" id="canvas-rollback-start" class="form-input">
                        <input type="datetime-local" id="canvas-rollback-end" class="form-input">
                    </div>
                    <button class="btn btn-primary" onclick="staffRollbackCanvas()"><i class="fa-solid fa-rotate-left"></i> Run Rollback</button>
                </div>
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-user-slash"></i> Canvas Ban</h3>
                    <div class="staff-form-grid">
                        <input type="text" id="canvas-ban-username" class="form-input" placeholder="Username">
                        <input type="text" id="canvas-ban-ip" class="form-input" placeholder="IP address (optional)">
                        <select id="canvas-ban-action" class="form-input">
                            <option value="ban">Ban</option>
                            <option value="mute">Mute</option>
                        </select>
                        <input type="datetime-local" id="canvas-ban-expires" class="form-input">
                        <textarea id="canvas-ban-reason" class="form-input staff-form-wide" rows="2" placeholder="Reason"></textarea>
                    </div>
                    <button class="btn btn-primary" onclick="staffCreateCanvasBan()"><i class="fa-solid fa-plus"></i> Add Canvas Ban</button>
                </div>
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-draw-polygon"></i> Region Lock</h3>
                    <div class="staff-form-grid">
                        <input type="text" id="canvas-region-label" class="form-input" placeholder="Label">
                        <select id="canvas-region-mode" class="form-input">
                            <option value="locked">Locked</option>
                            <option value="protected">Protected</option>
                        </select>
                        <input type="number" id="canvas-region-x1" class="form-input" placeholder="X1">
                        <input type="number" id="canvas-region-y1" class="form-input" placeholder="Y1">
                        <input type="number" id="canvas-region-x2" class="form-input" placeholder="X2">
                        <input type="number" id="canvas-region-y2" class="form-input" placeholder="Y2">
                        <input type="datetime-local" id="canvas-region-expires" class="form-input">
                        <textarea id="canvas-region-reason" class="form-input staff-form-wide" rows="2" placeholder="Reason"></textarea>
                    </div>
                    <button class="btn btn-primary" onclick="staffCreateCanvasRegion()"><i class="fa-solid fa-lock"></i> Add Region</button>
                </div>
            </div>

            <div class="staff-canvas-grid">
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Canvas Actions</h3>
                    <div class="staff-scroll-card">
                        ${staffCanvasCache.actions.length ? staffCanvasCache.actions.map((action) => `
                            <div class="staff-log-entry">
                                <strong>${esc(action.action_type || 'action')}</strong>
                                <span class="muted">${formatStaffDate(action.created_at)}</span>
                                <div class="muted">${esc(action.username || 'System')} at ${action.x ?? '-'}, ${action.y ?? '-'}</div>
                            </div>
                        `).join('') : '<p class="muted">No canvas actions yet.</p>'}
                    </div>
                </div>
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-user-lock"></i> Active Canvas Bans</h3>
                    <div class="staff-scroll-card">
                        ${staffCanvasCache.bans.length ? staffCanvasCache.bans.map((ban) => `
                            <div class="staff-log-entry">
                                <strong>${esc(ban.username || ban.ip_address || `Ban #${ban.id}`)}</strong>
                                <span class="muted">${esc(ban.action_type || 'ban')} - ${ban.expires_at ? formatStaffDate(ban.expires_at) : 'Permanent'}</span>
                                <div class="muted">${esc(ban.reason || 'No reason')}</div>
                                <button class="btn btn-small" onclick="staffRemoveCanvasBan(${ban.id})"><i class="fa-solid fa-trash"></i> Remove</button>
                            </div>
                        `).join('') : '<p class="muted">No active canvas bans.</p>'}
                    </div>
                </div>
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-border-all"></i> Region Locks</h3>
                    <div class="staff-scroll-card">
                        ${staffCanvasCache.regions.length ? staffCanvasCache.regions.map((region) => `
                            <div class="staff-log-entry">
                                <strong>${esc(region.label || `Region #${region.id}`)}</strong>
                                <span class="muted">${region.x1},${region.y1} to ${region.x2},${region.y2}</span>
                                <div class="muted">${esc(region.reason || region.mode || 'Locked')}</div>
                                <button class="btn btn-small" onclick="staffRemoveCanvasRegion(${region.id})"><i class="fa-solid fa-unlock"></i> Remove</button>
                            </div>
                        `).join('') : '<p class="muted">No active region locks.</p>'}
                    </div>
                </div>
            </div>

            <div class="staff-panel-card">
                <h3><i class="fa-solid fa-fire"></i> Canvas Heatmap</h3>
                ${renderCanvasHeatmap(staffCanvasCache.heatmap)}
            </div>

            ${hasCapability('can_manage_canvas_settings') ? `
                <div class="staff-panel-grid">
                    <div class="staff-panel-card staff-panel-card-wide">
                        <h3><i class="fa-solid fa-sliders"></i> Admin Canvas Settings</h3>
                        <div class="staff-settings-form">
                            <label><span>Frozen</span><input type="checkbox" id="canvas-setting-frozen" ${currentSettings.frozen ? 'checked' : ''}></label>
                            <label><span>Read Only</span><input type="checkbox" id="canvas-setting-readonly" ${currentSettings.read_only ? 'checked' : ''}></label>
                            <label><span>Tile Cooldown (s)</span><input type="number" id="canvas-setting-tile-cooldown" class="form-input" value="${Number(currentSettings.tile_cooldown_seconds || 20)}"></label>
                            <label><span>New Account Cooldown (s)</span><input type="number" id="canvas-setting-new-account-cooldown" class="form-input" value="${Number(currentSettings.new_account_cooldown_seconds || 12)}"></label>
                            <label class="staff-form-full"><span>Palette JSON</span><textarea id="canvas-setting-palette" class="form-input" rows="4">${esc(JSON.stringify(currentSettings.palette || [], null, 2))}</textarea></label>
                            <label class="staff-form-full"><span>Level Cooldowns JSON</span><textarea id="canvas-setting-levels" class="form-input" rows="6">${esc(JSON.stringify(currentSettings.level_cooldowns || [], null, 2))}</textarea></label>
                        </div>
                        <div class="staff-button-row">
                            <button class="btn btn-primary" onclick="staffSaveCanvasSettings()"><i class="fa-solid fa-floppy-disk"></i> Save Settings</button>
                            <button class="btn btn-outline" onclick="staffCreateCanvasSnapshot()"><i class="fa-solid fa-camera"></i> Snapshot</button>
                            <button class="btn btn-danger" onclick="staffWipeCanvas()"><i class="fa-solid fa-trash"></i> Wipe Board</button>
                        </div>
                    </div>
                    <div class="staff-panel-card">
                        <h3><i class="fa-solid fa-camera-retro"></i> Snapshots</h3>
                        <div class="staff-scroll-card">
                            ${staffCanvasCache.snapshots.length ? staffCanvasCache.snapshots.map((snapshot) => `
                                <div class="staff-log-entry">
                                    <strong>${esc(snapshot.name || `Snapshot ${snapshot.id}`)}</strong>
                                    <span class="muted">${formatStaffDate(snapshot.created_at)}</span>
                                    <div class="muted">${snapshot.metadata?.tile_count || 0} tiles</div>
                                    <button class="btn btn-small" onclick="staffRestoreCanvasSnapshot(${snapshot.id})"><i class="fa-solid fa-rotate-left"></i> Restore</button>
                                </div>
                            `).join('') : '<p class="muted">No snapshots yet.</p>'}
                        </div>
                    </div>
                    <div class="staff-panel-card">
                        <h3><i class="fa-solid fa-user-gear"></i> User Override</h3>
                        <div class="staff-form-grid">
                            <input type="text" id="canvas-override-username" class="form-input" placeholder="Username">
                            <input type="number" id="canvas-override-cooldown" class="form-input" placeholder="Cooldown seconds">
                            <input type="number" id="canvas-override-rate" class="form-input" placeholder="Placements per minute">
                            <label class="staff-inline-toggle"><input type="checkbox" id="canvas-override-bypass"> Bypass read only</label>
                            <textarea id="canvas-override-note" class="form-input staff-form-wide" rows="2" placeholder="Note"></textarea>
                        </div>
                        <button class="btn btn-primary" onclick="staffSaveCanvasOverride()"><i class="fa-solid fa-plus"></i> Save Override</button>
                        <div class="staff-scroll-card" style="margin-top:12px">
                            ${staffCanvasCache.overrides.length ? staffCanvasCache.overrides.map((override) => `
                                <div class="staff-log-entry">
                                    <strong>${esc(override.username || `User ${override.user_id}`)}</strong>
                                    <span class="muted">Cooldown ${override.cooldown_seconds ?? 'default'}s - Rate ${override.placements_per_minute ?? 'default'}/min</span>
                                    <div class="muted">${esc(override.note || '')}</div>
                                    <button class="btn btn-small" onclick="staffRemoveCanvasOverride(${override.user_id})"><i class="fa-solid fa-trash"></i> Remove</button>
                                </div>
                            `).join('') : '<p class="muted">No canvas user overrides.</p>'}
                        </div>
                    </div>
                </div>
            ` : `
                <div class="staff-panel-card">
                    <h3><i class="fa-solid fa-camera-retro"></i> Snapshots</h3>
                    <div class="staff-scroll-card">
                        ${staffCanvasCache.snapshots.length ? staffCanvasCache.snapshots.map((snapshot) => `
                            <div class="staff-log-entry">
                                <strong>${esc(snapshot.name || `Snapshot ${snapshot.id}`)}</strong>
                                <span class="muted">${formatStaffDate(snapshot.created_at)}</span>
                            </div>
                        `).join('') : '<p class="muted">No snapshots yet.</p>'}
                    </div>
                </div>
            `}
        `;
    } catch (err) {
        content.innerHTML = `<p class="muted">Failed to load canvas tools: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

window.staffSearchLogs = async function staffSearchLogs() {
    staffLogsQuery = document.getElementById('staff-log-search')?.value?.trim() || '';
    staffLogsUserId = document.getElementById('staff-log-userid')?.value?.trim() || '';
    staffLogsOffset = 0;
    await fetchStaffLogs();
};

window.staffLogsPrev = async function staffLogsPrev() {
    staffLogsOffset = Math.max(0, staffLogsOffset - 50);
    await fetchStaffLogs();
};

window.staffLogsNext = async function staffLogsNext() {
    staffLogsOffset += 50;
    await fetchStaffLogs();
};

window.staffOpenLogsForUser = async function staffOpenLogsForUser(userId, username) {
    staffLogsUserId = String(userId || '');
    staffLogsQuery = '';
    currentAdminTab = 'chat';
    renderStaffTabs();
    await loadStaffChatLogs();
    const searchField = document.getElementById('staff-log-search');
    const userField = document.getElementById('staff-log-userid');
    if (searchField) searchField.value = '';
    if (userField) userField.value = staffLogsUserId;
    toast(`Showing chat logs for ${username}`, 'info');
    await fetchStaffLogs();
};

window.staffForceEndStream = async function staffForceEndStream(streamId) {
    if (!confirm('Force end this stream?')) return;
    try {
        await api(`/mod/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'success');
        await loadStaffStats();
        await loadStaffStreams();
    } catch (err) {
        toast(err.message || 'Failed to end stream', 'error');
    }
};

window.staffBanUser = async function staffBanUser(userId, username, reason = 'Banned via staff tools', durationHours = 0) {
    try {
        await api(`/mod/users/${userId}/ban`, {
            method: 'POST',
            body: {
                reason,
                duration_hours: durationHours,
            },
        });
        toast(`${username || 'User'} banned`, 'success');
        if (currentAdminTab === 'bans') await loadStaffBans();
        await loadStaffStats();
    } catch (err) {
        toast(err.message || 'Failed to ban user', 'error');
    }
};

window.staffCreateSiteBan = async function staffCreateSiteBan() {
    const username = document.getElementById('staff-ban-username')?.value?.trim();
    const reason = document.getElementById('staff-ban-reason')?.value?.trim() || 'Banned by staff';
    const durationHours = Number(document.getElementById('staff-ban-duration')?.value || 0);
    if (!username) return toast('Enter a username to ban.', 'error');

    try {
        const userId = await resolveUsernameToUserId(username);
        if (!userId) throw new Error('User not found');
        await window.staffBanUser(userId, username, reason, durationHours);
    } catch (err) {
        toast(err.message || 'Failed to resolve user', 'error');
    }
};

window.staffUnbanUser = async function staffUnbanUser(userId) {
    try {
        await api(`/mod/users/${userId}/ban`, { method: 'DELETE' });
        toast('User unbanned', 'success');
        await loadStaffBans();
        await loadStaffStats();
    } catch (err) {
        toast(err.message || 'Failed to unban user', 'error');
    }
};

window.staffCreateCanvasBan = async function staffCreateCanvasBan() {
    const username = document.getElementById('canvas-ban-username')?.value?.trim();
    const ipAddress = document.getElementById('canvas-ban-ip')?.value?.trim();
    const actionType = document.getElementById('canvas-ban-action')?.value || 'ban';
    const expiresAt = toIsoFromInput(document.getElementById('canvas-ban-expires')?.value);
    const reason = document.getElementById('canvas-ban-reason')?.value?.trim() || 'Canvas moderation action';

    if (!username && !ipAddress) return toast('Provide a username or IP address.', 'error');

    try {
        const payload = {
            ip_address: ipAddress || null,
            action_type: actionType,
            reason,
            expires_at: expiresAt,
        };
        if (username) payload.user_id = await resolveUsernameToUserId(username);
        await api('/game/canvas/staff/bans', { method: 'POST', body: payload });
        toast('Canvas ban saved', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to create canvas ban', 'error');
    }
};

window.staffRemoveCanvasBan = async function staffRemoveCanvasBan(id) {
    try {
        await api(`/game/canvas/staff/bans/${id}`, { method: 'DELETE' });
        toast('Canvas ban removed', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to remove canvas ban', 'error');
    }
};

window.staffCreateCanvasRegion = async function staffCreateCanvasRegion() {
    try {
        await api('/game/canvas/staff/regions', {
            method: 'POST',
            body: {
                label: document.getElementById('canvas-region-label')?.value?.trim() || '',
                mode: document.getElementById('canvas-region-mode')?.value || 'locked',
                x1: Number(document.getElementById('canvas-region-x1')?.value || 0),
                y1: Number(document.getElementById('canvas-region-y1')?.value || 0),
                x2: Number(document.getElementById('canvas-region-x2')?.value || 0),
                y2: Number(document.getElementById('canvas-region-y2')?.value || 0),
                expires_at: toIsoFromInput(document.getElementById('canvas-region-expires')?.value),
                reason: document.getElementById('canvas-region-reason')?.value?.trim() || '',
            },
        });
        toast('Canvas region saved', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to save canvas region', 'error');
    }
};

window.staffRemoveCanvasRegion = async function staffRemoveCanvasRegion(id) {
    try {
        await api(`/game/canvas/staff/regions/${id}`, { method: 'DELETE' });
        toast('Canvas region removed', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to remove canvas region', 'error');
    }
};

window.staffRollbackCanvas = async function staffRollbackCanvas() {
    const payload = {
        mode: document.getElementById('canvas-rollback-mode')?.value || 'tile',
        x: Number(document.getElementById('canvas-rollback-x')?.value || 0),
        y: Number(document.getElementById('canvas-rollback-y')?.value || 0),
        user_id: Number(document.getElementById('canvas-rollback-user')?.value || 0),
        x1: Number(document.getElementById('canvas-rollback-x1')?.value || 0),
        y1: Number(document.getElementById('canvas-rollback-y1')?.value || 0),
        x2: Number(document.getElementById('canvas-rollback-x2')?.value || 0),
        y2: Number(document.getElementById('canvas-rollback-y2')?.value || 0),
        start_at: toIsoFromInput(document.getElementById('canvas-rollback-start')?.value),
        end_at: toIsoFromInput(document.getElementById('canvas-rollback-end')?.value),
    };

    try {
        const data = await api('/game/canvas/staff/rollback', { method: 'POST', body: payload });
        toast(`Rolled back ${data.count || 0} tiles`, 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Canvas rollback failed', 'error');
    }
};

window.staffSaveCanvasSettings = async function staffSaveCanvasSettings() {
    try {
        await api('/game/canvas/admin/settings', {
            method: 'POST',
            body: {
                frozen: !!document.getElementById('canvas-setting-frozen')?.checked,
                read_only: !!document.getElementById('canvas-setting-readonly')?.checked,
                tile_cooldown_seconds: Number(document.getElementById('canvas-setting-tile-cooldown')?.value || 20),
                new_account_cooldown_seconds: Number(document.getElementById('canvas-setting-new-account-cooldown')?.value || 12),
                palette: JSON.parse(document.getElementById('canvas-setting-palette')?.value || '[]'),
                level_cooldowns: JSON.parse(document.getElementById('canvas-setting-levels')?.value || '[]'),
            },
        });
        toast('Canvas settings saved', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to save canvas settings', 'error');
    }
};

window.staffCreateCanvasSnapshot = async function staffCreateCanvasSnapshot() {
    const name = prompt('Snapshot name:', `Canvas snapshot ${new Date().toLocaleString()}`);
    if (name === null) return;
    try {
        await api('/game/canvas/admin/snapshots', { method: 'POST', body: { name } });
        toast('Canvas snapshot created', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to create snapshot', 'error');
    }
};

window.staffRestoreCanvasSnapshot = async function staffRestoreCanvasSnapshot(id) {
    if (!confirm('Restore this snapshot? This rewrites the board state.')) return;
    try {
        await api(`/game/canvas/admin/snapshots/${id}/restore`, { method: 'POST' });
        toast('Canvas snapshot restored', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to restore snapshot', 'error');
    }
};

window.staffWipeCanvas = async function staffWipeCanvas() {
    if (!confirm('Wipe the full canvas board? This cannot be undone without a snapshot restore.')) return;
    try {
        await api('/game/canvas/admin/wipe', { method: 'POST' });
        toast('Canvas wiped', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to wipe canvas', 'error');
    }
};

window.staffSaveCanvasOverride = async function staffSaveCanvasOverride() {
    const username = document.getElementById('canvas-override-username')?.value?.trim();
    if (!username) return toast('Enter a username for the override.', 'error');

    try {
        const userId = await resolveUsernameToUserId(username);
        await api('/game/canvas/admin/overrides', {
            method: 'POST',
            body: {
                user_id: userId,
                cooldown_seconds: document.getElementById('canvas-override-cooldown')?.value ? Number(document.getElementById('canvas-override-cooldown').value) : null,
                placements_per_minute: document.getElementById('canvas-override-rate')?.value ? Number(document.getElementById('canvas-override-rate').value) : null,
                bypass_read_only: !!document.getElementById('canvas-override-bypass')?.checked,
                note: document.getElementById('canvas-override-note')?.value?.trim() || '',
            },
        });
        toast('Canvas override saved', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to save override', 'error');
    }
};

window.staffRemoveCanvasOverride = async function staffRemoveCanvasOverride(userId) {
    try {
        await api(`/game/canvas/admin/overrides/${userId}`, { method: 'DELETE' });
        toast('Canvas override removed', 'success');
        await loadStaffCanvas();
    } catch (err) {
        toast(err.message || 'Failed to remove override', 'error');
    }
};

window.loadAdmin = async function loadAdminOverride() {
    if (!isStaffUser()) {
        toast('Staff access required', 'error');
        return navigate('/');
    }

    currentAdminTab = ensureAllowedStaffTab(currentAdminTab || 'overview');
    renderStaffTabs();
    await loadStaffStats();
    await window.switchAdminTab(currentAdminTab);
};

window.switchAdminTab = async function switchAdminTabOverride(tab) {
    currentAdminTab = ensureAllowedStaffTab(tab);
    renderStaffTabs();

    if (LEGACY_ADMIN_TAB_LOADERS[currentAdminTab]) {
        LEGACY_ADMIN_TAB_LOADERS[currentAdminTab]();
        return;
    }

    switch (currentAdminTab) {
        case 'overview':
            await loadStaffOverview();
            break;
        case 'chat':
            await loadStaffChatLogs();
            break;
        case 'streams':
            await loadStaffStreams();
            break;
        case 'bans':
            await loadStaffBans();
            break;
        case 'actions':
            await loadStaffActions();
            break;
        case 'canvas':
            await loadStaffCanvas();
            break;
        default:
            document.getElementById('admin-content').innerHTML = '<p class="muted">Staff panel is loading...</p>';
            break;
    }
};

loadAdmin = window.loadAdmin;
switchAdminTab = window.switchAdminTab;
loadAdminStats = loadStaffStats;
