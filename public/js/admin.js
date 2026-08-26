/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Admin Panel
   ═══════════════════════════════════════════════════════════════ */

let currentAdminTab = 'users';
const adminSecretStore = Object.create(null);

function isSensitiveAdminSettingKey(key = '') {
    return /(password|secret|token|private|credential|api[_-]?key|service[_-]?account|bearer|webhook)/i.test(String(key || ''));
}

function maskAdminSecret(value) {
    const str = String(value ?? '');
    if (!str) return '••••••••';
    if (str.length <= 8) return '•'.repeat(str.length);
    return `${str.slice(0, 4)}${'•'.repeat(Math.max(4, str.length - 8))}${str.slice(-4)}`;
}

function adminCopyText(text, successMessage = 'Copied to clipboard') {
    const value = String(text ?? '');
    if (!value) {
        toast('Nothing to copy', 'error');
        return Promise.resolve(false);
    }

    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(value)
            .then(() => {
                toast(successMessage, 'success');
                return true;
            })
            .catch(() => adminCopyTextFallback(value, successMessage));
    }

    return adminCopyTextFallback(value, successMessage);
}

function adminCopyTextFallback(text, successMessage) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast(successMessage, 'success');
        return Promise.resolve(true);
    } catch {
        toast('Copy failed', 'error');
        return Promise.resolve(false);
    }
}

function copyAdminSecret(secretId) {
    return adminCopyText(adminSecretStore[secretId], 'Secret copied to clipboard');
}

function toggleAdminSecret(secretId, button) {
    const el = document.getElementById(secretId);
    if (!el) return;

    const visible = el.dataset.visible === 'true';
    const nextVisible = !visible;
    el.dataset.visible = nextVisible ? 'true' : 'false';
    el.textContent = nextVisible ? String(adminSecretStore[secretId] ?? '') : maskAdminSecret(adminSecretStore[secretId]);
    el.classList.toggle('is-masked', !nextVisible);

    if (button) {
        button.innerHTML = `<i class="fa-solid ${nextVisible ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        button.title = nextVisible ? 'Hide value' : 'Reveal value';
        button.setAttribute('aria-label', button.title);
    }
}

function toggleAdminSensitiveInput(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const isTextarea = input.tagName === 'TEXTAREA';
    const masked = isTextarea ? input.dataset.masked !== 'false' : input.type === 'password';
    const nextMasked = !masked;

    if (isTextarea) {
        input.dataset.masked = nextMasked ? 'true' : 'false';
        input.readOnly = nextMasked;
        input.classList.toggle('is-masked', nextMasked);
        if (!nextMasked) input.focus();
    } else {
        input.type = nextMasked ? 'password' : 'text';
    }

    if (button) {
        button.innerHTML = `<i class="fa-solid ${nextMasked ? 'fa-eye' : 'fa-eye-slash'}"></i> ${nextMasked ? 'Reveal' : 'Hide'}`;
        button.setAttribute('aria-pressed', String(!nextMasked));
    }
}

function copyAdminSensitiveInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return Promise.resolve(false);
    return adminCopyText(input.value, 'Value copied to clipboard');
}

/**
 * Load admin panel.
 */
async function loadAdmin() {
    if (!currentUser || !currentUser.capabilities?.admin_panel) {
        toast('Admin access required', 'error');
        return navigate('home');
    }

    await loadAdminStats();
    // Global mods see only a subset of tabs
    const isFullAdmin = currentUser.capabilities?.manage_users;
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(btn => {
        const tab = btn.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        // Global mods can see: chat-logs, bans, moderators
        const modTabs = ['chat-logs', 'bans', 'moderators'];
        if (!isFullAdmin && tab && !modTabs.includes(tab)) {
            btn.style.display = 'none';
        } else {
            btn.style.display = '';
        }
    });
    switchAdminTab(isFullAdmin ? 'users' : 'chat-logs');
}

/* ── Stats ─────────────────────────────────────────────────────── */
async function loadAdminStats() {
    const container = document.getElementById('admin-stats');
    try {
        const data = await api('/admin/stats');
        const s = data.stats || data;
        container.innerHTML = [
            { label: 'Total Users', value: s.totalUsers || s.users?.total || 0, icon: 'fa-users' },
            { label: 'Active Streams', value: s.activeStreams || s.streams?.live || 0, icon: 'fa-broadcast-tower' },
            { label: 'Total Streams', value: s.totalStreams || s.streams?.total || 0, icon: 'fa-video' },
            { label: 'Vibes in Circulation', value: s.totalFunds || s.openvibeBucks?.totalCirculating || 0, icon: 'fa-coins' },
            { label: 'Pending Cashouts', value: s.pendingCashouts || s.openvibeBucks?.pendingCashouts || 0, icon: 'fa-money-bill-transfer' },
            { label: 'Active Bans', value: s.activeBans || s.users?.banned || 0, icon: 'fa-ban' },
        ].map(stat => `
            <div class="admin-stat">
                <div class="admin-stat-value">${typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}</div>
                <div class="admin-stat-label"><i class="fa-solid ${stat.icon}"></i> ${stat.label}</div>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<p class="muted">Failed to load stats</p>';
    }
}

/* ── Tab switching ─────────────────────────────────────────────── */
function switchAdminTab(tab) {
    currentAdminTab = tab;
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(b =>
        b.classList.toggle('active', b.getAttribute('onclick')?.includes(`'${tab}'`))
    );

    switch (tab) {
        case 'users': loadAdminUsers(); break;
        case 'moderators': loadAdminModerators(); break;
        case 'chat-logs': loadAdminChatLogs(); break;
        case 'settings': loadAdminSettings(); break;
        case 'tts': loadAdminTTS(); break;
        case 'verification': loadAdminVerificationKeys(); break;
        case 'streams': loadAdminStreams(); break;
        case 'cashouts': loadAdminCashouts(); break;
        case 'bans': loadAdminBans(); break;
        case 'vpn': loadAdminVPN(); break;
        case 'pastes': loadAdminPastes(); break;
        case 'data': loadAdminData(); break;
        case 'media-tools': loadAdminMediaTools(); break;
    }
}

/* ── Chat Logs (Admin) ─────────────────────────────────────────── */
let adminLogsOffset = 0;
let adminLogsQuery = '';
let adminLogsUserId = '';
let adminLogsPage = 1;

async function loadAdminChatLogs() {
    const c = document.getElementById('admin-content');
    c.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
            <input type="text" id="admin-log-search" placeholder="Search messages..."
                value="${esc(adminLogsQuery)}"
                onkeydown="if(event.key==='Enter')adminSearchLogs()"
                style="flex:1;min-width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
            <input type="text" id="admin-log-userid" placeholder="Username (optional)"
                value="${esc(adminLogsUserId)}"
                onkeydown="if(event.key==='Enter')adminSearchLogs()"
                style="width:160px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
            <input type="number" id="admin-log-streamid" placeholder="Stream ID"
                style="width:120px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
            <button class="btn btn-primary" onclick="adminSearchLogs()">
                <i class="fa-solid fa-search"></i> Search
            </button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
            <label style="font-size:0.85rem;color:var(--text-muted)">From:</label>
            <input type="datetime-local" id="admin-log-from" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
            <label style="font-size:0.85rem;color:var(--text-muted)">To:</label>
            <input type="datetime-local" id="admin-log-to" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
            <button class="btn btn-sm" onclick="adminExportLogs('csv')" title="Export as CSV"><i class="fa-solid fa-file-csv"></i> CSV</button>
            <button class="btn btn-sm" onclick="adminExportLogs('json')" title="Export as JSON"><i class="fa-solid fa-file-code"></i> JSON</button>
        </div>
        <details style="margin-bottom:12px;background:var(--bg-secondary);padding:10px 14px;border-radius:8px;border:1px solid var(--border)">
            <summary style="cursor:pointer;font-size:0.85rem;color:var(--accent);font-weight:600"><i class="fa-solid fa-trash-can"></i> Purge Messages by Time Range</summary>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <label style="font-size:0.85rem;color:var(--text-muted)">From:</label>
                <input type="datetime-local" id="admin-purge-from" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
                <label style="font-size:0.85rem;color:var(--text-muted)">To:</label>
                <input type="datetime-local" id="admin-purge-to" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
                <input type="number" id="admin-purge-streamid" placeholder="Stream ID (blank = global)" style="width:180px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
                <button class="btn btn-sm" onclick="adminPurgePreview()"><i class="fa-solid fa-eye"></i> Preview</button>
                <span id="admin-purge-count" style="font-size:0.85rem;color:var(--text-muted)"></span>
                <button class="btn btn-sm btn-danger" id="admin-purge-btn" onclick="adminPurgeExecute()" style="display:none"><i class="fa-solid fa-trash"></i> Delete</button>
            </div>
        </details>
        <div id="admin-logs-results"><p class="muted">Enter a search query, username, or stream ID to search chat logs</p></div>
        <div id="admin-logs-pager" style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:12px"></div>
    `;
}

function _adminLogFilterParams() {
    const params = new URLSearchParams();
    const q = document.getElementById('admin-log-search')?.value?.trim();
    const user = document.getElementById('admin-log-userid')?.value?.trim();
    const streamId = document.getElementById('admin-log-streamid')?.value?.trim();
    const from = document.getElementById('admin-log-from')?.value;
    const to = document.getElementById('admin-log-to')?.value;
    if (q) params.set('search', q);
    if (user) params.set('username', user);
    if (streamId) params.set('streamId', streamId);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(to).toISOString());
    return params;
}

async function adminSearchLogs() {
    adminLogsQuery = document.getElementById('admin-log-search')?.value?.trim() || '';
    adminLogsUserId = document.getElementById('admin-log-userid')?.value?.trim() || '';
    adminLogsPage = 1;
    await fetchAdminLogs();
}

async function fetchAdminLogs() {
    const results = document.getElementById('admin-logs-results');
    const pager = document.getElementById('admin-logs-pager');
    if (!results) return;
    results.innerHTML = '<p class="muted">Loading...</p>';

    try {
        const params = _adminLogFilterParams();
        params.set('page', String(adminLogsPage));
        params.set('limit', '50');

        const data = await api(`/chat/admin/logs?${params}`);
        const msgs = data.rows || [];
        const total = data.total || 0;
        const totalPages = data.totalPages || 1;

        if (!msgs.length) {
            results.innerHTML = '<p class="muted">No messages found</p>';
            if (pager) pager.innerHTML = '';
            return;
        }

        results.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Time</th><th>User</th><th>Message</th><th>Stream</th><th>Type</th>
                </tr></thead>
                <tbody>${msgs.map(m => {
                    const ts = m.timestamp ? new Date(m.timestamp.replace(' ', 'T') + (m.timestamp.includes('Z') ? '' : 'Z')).toLocaleString() : '';
                    return `<tr${m.is_deleted ? ' style="opacity:0.4"' : ''}>
                        <td style="white-space:nowrap;font-size:0.8rem">${ts}</td>
                        <td style="white-space:nowrap">
                            <span style="color:${esc(m.profile_color || '#999')};cursor:pointer" onclick="showChatContextMenu(event)" data-username="${esc(m.display_name || m.username || 'anon')}" data-user-id="${esc(String(m.user_id || ''))}">${esc(m.display_name || m.username || 'anon')}</span>
                        </td>
                        <td style="word-break:break-word">${esc(m.message || '')}</td>
                        <td style="font-size:0.8rem">${m.stream_id || (m.is_global ? 'global' : '-')}</td>
                        <td style="font-size:0.75rem;color:var(--text-muted)">${m.message_type || 'chat'}${m.is_deleted ? ' <i class="fa-solid fa-trash" style="color:var(--danger)"></i>' : ''}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>`;

        if (pager) {
            pager.innerHTML = totalPages > 1 ? `
                <button class="btn btn-sm" ${adminLogsPage <= 1 ? 'disabled' : ''} onclick="adminLogsPage--;fetchAdminLogs()"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="muted" style="font-size:0.85rem">Page ${adminLogsPage} / ${totalPages} (${total} results)</span>
                <button class="btn btn-sm" ${adminLogsPage >= totalPages ? 'disabled' : ''} onclick="adminLogsPage++;fetchAdminLogs()"><i class="fa-solid fa-chevron-right"></i></button>
            ` : `<span class="muted" style="font-size:0.85rem">${total} results</span>`;
        }
    } catch (e) {
        results.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
        if (pager) pager.innerHTML = '';
    }
}

async function adminPurgePreview() {
    const from = document.getElementById('admin-purge-from')?.value;
    const to = document.getElementById('admin-purge-to')?.value;
    const streamId = document.getElementById('admin-purge-streamid')?.value?.trim() || null;
    const countEl = document.getElementById('admin-purge-count');
    const btn = document.getElementById('admin-purge-btn');
    if (!from || !to) { toast('Select both from and to dates', 'error'); return; }

    try {
        const data = await api('/chat/admin/purge/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamId: streamId ? parseInt(streamId) : null, from: new Date(from).toISOString(), to: new Date(to).toISOString() })
        });
        const count = data.count || 0;
        countEl.textContent = `${count} message${count !== 1 ? 's' : ''} will be deleted`;
        btn.style.display = count > 0 ? '' : 'none';
    } catch (e) {
        countEl.textContent = `Error: ${e.message}`;
        btn.style.display = 'none';
    }
}

async function adminPurgeExecute() {
    const from = document.getElementById('admin-purge-from')?.value;
    const to = document.getElementById('admin-purge-to')?.value;
    const streamId = document.getElementById('admin-purge-streamid')?.value?.trim() || null;
    if (!from || !to) return;
    if (!confirm('Are you sure you want to delete these messages? This action cannot be undone.')) return;

    try {
        const data = await api('/chat/admin/purge', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamId: streamId ? parseInt(streamId) : null, from: new Date(from).toISOString(), to: new Date(to).toISOString() })
        });
        toast(`Deleted ${data.deleted || 0} messages`, 'success');
        document.getElementById('admin-purge-count').textContent = '';
        document.getElementById('admin-purge-btn').style.display = 'none';
        // Refresh the search results if any
        if (document.getElementById('admin-logs-results')?.querySelector('table')) fetchAdminLogs();
    } catch (e) {
        toast(`Purge failed: ${e.message}`, 'error');
    }
}

async function adminExportLogs(format) {
    const params = _adminLogFilterParams();
    params.set('format', format);
    const token = localStorage.getItem('token');
    try {
        const res = await fetch(`/api/chat/admin/logs/export?${params}`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-logs-${Date.now()}.${format === 'csv' ? 'csv' : 'json'}`;
        a.click();
        URL.revokeObjectURL(url);
        toast(`Exported as ${format.toUpperCase()}`, 'success');
    } catch (e) {
        toast(`Export failed: ${e.message}`, 'error');
    }
}

/* ── Users ─────────────────────────────────────────────────────── */
async function loadAdminUsers() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/users');
        const users = data.users || [];
        c.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85rem;color:var(--text-secondary)">
                    <input type="checkbox" id="admin-show-emails" onchange="toggleAdminEmails(this.checked)" style="width:16px;height:16px;cursor:pointer">
                    Show emails
                </label>
            </div>
            <table class="admin-table">
                <thead><tr>
                    <th>Username</th><th class="admin-email-col" style="display:none">Email</th><th>Role</th><th>Created</th><th>Actions</th>
                </tr></thead>
                <tbody>${users.map(u => `
                    <tr>
                        <td>${esc(u.username)}</td>
                        <td class="admin-email-col" style="display:none">${esc(u.email || '-')}</td>
                        <td>${esc(u.role)}</td>
                        <td>${new Date(u.created_at).toLocaleDateString()}</td>
                        <td>
                            <select onchange="changeUserRole('${u.id}', this.value)" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:4px">
                                ${['user','streamer','global_mod','admin'].map(r =>
                                    `<option value="${r}" ${r===u.role?'selected':''}>${r}</option>`
                                ).join('')}
                            </select>
                            <button class="btn btn-small btn-danger" onclick="banUser('${u.id}', '${esc(u.username)}')" title="Ban">
                                <i class="fa-solid fa-ban"></i>
                            </button>
                            <button
                                class="btn btn-small ${u.force_vod_recording_disabled ? 'btn-success' : 'btn-warning'}"
                                onclick="adminSetUserForcedVodRecording('${u.id}', ${u.force_vod_recording_disabled ? 'false' : 'true'})"
                                title="${u.force_vod_recording_disabled ? 'Re-enable channel-controlled VOD recording' : 'Force-disable VOD recording for this user channel'}"
                            >
                                <i class="fa-solid ${u.force_vod_recording_disabled ? 'fa-power-off' : 'fa-hdd'}"></i>
                                ${u.force_vod_recording_disabled ? 'Allow VOD' : 'Force Off VOD'}
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function toggleAdminEmails(show) {
    document.querySelectorAll('.admin-email-col').forEach(el => {
        el.style.display = show ? '' : 'none';
    });
}

async function changeUserRole(userId, role) {
    try {
        await api(`/admin/users/${userId}`, { method: 'PUT', body: { role } });
        toast(`Role updated to ${role}`, 'success');
    } catch (e) { toast(e.message, 'error'); loadAdminUsers(); }
}

async function banUser(userId, username) {
    const reason = prompt(`Ban ${username}? Enter reason:`);
    if (reason === null) return;
    try {
        await api(`/admin/users/${userId}/ban`, { method: 'POST', body: { reason, duration: 0 } });
        toast(`${username} banned`, 'success');
        loadAdminUsers();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

async function adminSetUserForcedVodRecording(userId, forceDisable) {
    const promptText = forceDisable
        ? 'Force-disable VOD recording for this user channel? This overrides the user toggle.'
        : 'Remove forced VOD disable and allow this user to control VOD recording again?';
    if (!confirm(promptText)) return;
    try {
        await api(`/admin/users/${userId}/force-vod-recording`, {
            method: 'PUT',
            body: { force: !!forceDisable },
        });
        toast(forceDisable ? 'Forced VOD disable enabled' : 'Forced VOD disable removed', 'success');
        loadAdminUsers();
        if (currentAdminTab === 'streams') loadAdminStreams();
    } catch (e) {
        toast(e.message, 'error');
    }
}

/* ── Moderators ───────────────────────────────────────────────── */
async function loadAdminModerators() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/moderators');
        const mods = data.moderators || [];
        c.innerHTML = `
            <div class="admin-section-header" style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
                <input type="text" id="mod-username-input" placeholder="Username to promote..."
                    style="flex:1;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <button class="btn btn-primary" onclick="promoteModerator()">
                    <i class="fa-solid fa-shield-halved"></i> Promote to Global Mod
                </button>
            </div>
            ${mods.length ? `
                <table class="admin-table">
                    <thead><tr>
                        <th>Username</th><th>Display Name</th><th>Last Seen</th><th>Actions</th>
                    </tr></thead>
                    <tbody>${mods.map(m => `
                        <tr>
                            <td>${esc(m.username)}</td>
                            <td>${esc(m.display_name || m.username)}</td>
                            <td>${m.last_seen ? new Date(m.last_seen).toLocaleString() : 'Never'}</td>
                            <td>
                                <button class="btn btn-small btn-danger" onclick="demoteModerator('${m.id}', '${esc(m.username)}')">
                                    <i class="fa-solid fa-user-minus"></i> Demote
                                </button>
                            </td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            ` : '<p class="muted">No global moderators yet</p>'}`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function promoteModerator() {
    const input = document.getElementById('mod-username-input');
    const username = input?.value.trim();
    if (!username) return toast('Enter a username', 'error');
    try {
        await api('/admin/moderators', { method: 'POST', body: { username } });
        toast(`${username} promoted to global moderator`, 'success');
        loadAdminModerators();
    } catch (e) { toast(e.message, 'error'); }
}

async function demoteModerator(id, username) {
    if (!confirm(`Demote ${username} from global moderator?`)) return;
    try {
        await api(`/admin/moderators/${id}`, { method: 'DELETE' });
        toast(`${username} demoted`, 'success');
        loadAdminModerators();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Site Settings ────────────────────────────────────────────── */
async function loadAdminSettings() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/settings');
        const settings = data.settings || [];

        // Integrations get their own boxed section instead of interleaving
        // alphabetically with everything else.
        const SECTIONS = [
            { title: 'PowerChat', icon: 'fa-bolt', match: (k) => k.startsWith('powerchat_') },
        ];
        const sectioned = new Map(SECTIONS.map(sec => [sec, []]));
        const general = [];
        for (const s of settings) {
            const sec = SECTIONS.find(x => x.match(s.key));
            if (sec) sectioned.get(sec).push(s); else general.push(s);
        }

        const renderRow = (s) => {
                    const id = `setting-${s.key}`;
                    if (s.type === 'boolean') {
                        return `
                            <div class="setting-row" style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
                                <label style="flex:1;cursor:pointer" for="${id}">
                                    <strong>${esc(s.key)}</strong>
                                    <br><small class="muted">${esc(s.description || '')}</small>
                                </label>
                                <input type="checkbox" id="${id}" data-key="${esc(s.key)}" data-type="boolean"
                                    ${s.value === 'true' ? 'checked' : ''}
                                    style="width:18px;height:18px;cursor:pointer">
                            </div>`;
                    }
                    if (s.type === 'number') {
                        return `
                            <div class="setting-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
                                <label for="${id}">
                                    <strong>${esc(s.key)}</strong>
                                    <br><small class="muted">${esc(s.description || '')}</small>
                                </label>
                                <input type="number" id="${id}" data-key="${esc(s.key)}" data-type="number"
                                    value="${esc(s.value)}"
                                    style="margin-top:4px;width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                            </div>`;
                    }
                    return `
                        <div class="setting-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
                            <label for="${id}">
                                <strong>${esc(s.key)}</strong>
                                <br><small class="muted">${esc(s.description || '')}</small>
                            </label>
                            ${isSensitiveAdminSettingKey(s.key) ? `
                                <div class="admin-sensitive-field">
                                    <input type="password" id="${id}" data-key="${esc(s.key)}" data-type="string"
                                        value="${esc(s.value)}" autocomplete="off" spellcheck="false"
                                        style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                    <div class="admin-sensitive-actions">
                                        <button type="button" class="btn btn-small btn-outline" onclick="toggleAdminSensitiveInput('${id}', this)">
                                            <i class="fa-solid fa-eye"></i> Reveal
                                        </button>
                                        <button type="button" class="btn btn-small btn-outline" onclick="copyAdminSensitiveInput('${id}')">
                                            <i class="fa-solid fa-copy"></i> Copy
                                        </button>
                                    </div>
                                </div>
                            ` : `
                                <input type="text" id="${id}" data-key="${esc(s.key)}" data-type="string"
                                    value="${esc(s.value)}"
                                    style="margin-top:4px;width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                            `}
                        </div>`;
        };

        c.innerHTML = `
            <form id="admin-settings-form" onsubmit="saveAdminSettings(event)" style="display:grid;gap:12px;max-width:700px">
                ${general.map(renderRow).join('')}
                ${SECTIONS.map(sec => {
                    const rows = sectioned.get(sec);
                    if (!rows.length) return '';
                    return `
                        <div class="bc-settings-group" style="padding:12px;border:1px solid var(--border);border-radius:8px;margin-top:8px">
                            <h4 style="margin:0 0 4px;display:flex;align-items:center;gap:8px">
                                <i class="fa-solid ${sec.icon}" style="color:var(--accent)"></i> ${esc(sec.title)}
                            </h4>
                            ${rows.map(renderRow).join('')}
                        </div>`;
                }).join('')}
                <button type="submit" class="btn btn-primary" style="justify-self:start;margin-top:8px">
                    <i class="fa-solid fa-floppy-disk"></i> Save Settings
                </button>
            </form>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function saveAdminSettings(e) {
    e.preventDefault();
    const inputs = document.querySelectorAll('#admin-settings-form [data-key]');
    const settings = {};
    inputs.forEach(input => {
        const key = input.dataset.key;
        if (input.dataset.type === 'boolean') {
            settings[key] = input.checked ? 'true' : 'false';
        } else {
            settings[key] = input.value;
        }
    });
    try {
        await api('/admin/settings', { method: 'PUT', body: { settings } });
        toast('Settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Verification Keys ────────────────────────────────────────── */
async function loadAdminVerificationKeys() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/verification-keys');
        const keys = data.keys || [];
        keys.forEach(k => {
            adminSecretStore[`verification-key-${k.id}`] = k.key || '';
        });
        c.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
                <input type="text" id="vkey-username-input" placeholder="RS-Companion username to reserve..."
                    style="flex:1;min-width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <input type="text" id="vkey-note-input" placeholder="Note (optional)"
                    style="flex:1;min-width:150px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:14px">
                <button class="btn btn-primary" onclick="generateVerificationKey()">
                    <i class="fa-solid fa-key"></i> Generate Key
                </button>
            </div>
            ${keys.length ? `
                <table class="admin-table">
                    <thead><tr>
                        <th>Key</th><th>Reserved Username</th><th>Status</th><th>Note</th><th>Created</th><th>Actions</th>
                    </tr></thead>
                    <tbody>${keys.map(k => `
                        <tr>
                            <td>
                                <div class="admin-secret-inline">
                                    <code id="verification-key-${k.id}" class="admin-secret-value is-masked" data-visible="false">${esc(maskAdminSecret(k.key))}</code>
                                </div>
                            </td>
                            <td><strong>${esc(k.target_username)}</strong></td>
                            <td><span class="badge badge-${k.status === 'active' ? 'success' : k.status === 'used' ? 'info' : 'danger'}">${esc(k.status)}</span></td>
                            <td>${esc(k.note || '-')}</td>
                            <td>${new Date(k.created_at).toLocaleDateString()}</td>
                            <td>
                                ${k.status === 'active' ? `
                                    <button class="btn btn-small btn-outline" onclick="toggleAdminSecret('verification-key-${k.id}', this)" title="Reveal value" aria-label="Reveal value">
                                        <i class="fa-solid fa-eye"></i>
                                    </button>
                                    <button class="btn btn-small btn-outline" onclick="copyVerificationKey('verification-key-${k.id}')" title="Copy key">
                                        <i class="fa-solid fa-copy"></i>
                                    </button>
                                    <button class="btn btn-small btn-danger" onclick="revokeVerificationKey('${k.id}')" title="Revoke">
                                        <i class="fa-solid fa-trash"></i>
                                    </button>
                                ` : k.status === 'used' ? `<span class="muted">Used by ${esc(k.used_by_name || '?')}</span>` : '<span class="muted">Revoked</span>'}
                            </td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            ` : '<p class="muted">No verification keys generated yet</p>'}`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function generateVerificationKey() {
    const usernameInput = document.getElementById('vkey-username-input');
    const noteInput = document.getElementById('vkey-note-input');
    const target_username = usernameInput?.value.trim();
    const note = noteInput?.value.trim();
    if (!target_username) return toast('Enter a username to reserve', 'error');
    try {
        const data = await api('/admin/verification-keys', {
            method: 'POST',
            body: { target_username, note }
        });
        const key = data.key;
        if (key?.id && key?.key) adminSecretStore[`verification-key-${key.id}`] = key.key;
        toast('Verification key generated', 'success');
        usernameInput.value = '';
        noteInput.value = '';
        loadAdminVerificationKeys();
    } catch (e) { toast(e.message, 'error'); }
}

async function copyVerificationKey(secretId) {
    await copyAdminSecret(secretId);
}

async function revokeVerificationKey(id) {
    if (!confirm('Revoke this verification key?')) return;
    try {
        await api(`/admin/verification-keys/${id}`, { method: 'DELETE' });
        toast('Key revoked', 'success');
        loadAdminVerificationKeys();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Streams ──────────────────────────────────────────────────── */
async function loadAdminStreams() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/streams');
        const streams = data.streams || [];
        if (!streams.length) { c.innerHTML = '<p class="muted">No active streams</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Title</th><th>Streamer</th><th>Protocol</th><th>NSFW</th><th>VOD</th><th>Viewers</th><th>Started</th><th>Actions</th>
                </tr></thead>
                <tbody>${streams.map(s => `
                    <tr>
                        <td>${esc(s.title || 'Untitled')}</td>
                        <td>${esc(s.username || '-')}</td>
                        <td>${esc(s.protocol)}</td>
                        <td>${s.is_nsfw ? '<span style="color:var(--danger);font-weight:700">18+</span>' : '-'}</td>
                        <td>
                            ${s.force_vod_recording_disabled
                                ? '<span style="color:var(--danger);font-weight:700">Forced Off</span>'
                                : (s.vod_recording_enabled ? '<span style="color:var(--success);font-weight:700">On</span>' : '<span class="muted">User Off</span>')}
                        </td>
                        <td>${s.viewer_count || 0}</td>
                        <td>${new Date(s.started_at).toLocaleString()}</td>
                        <td style="display:flex;gap:4px;flex-wrap:wrap">
                            <button class="btn btn-small ${s.is_nsfw ? 'btn-outline' : 'btn-warning'}" onclick="adminToggleStreamNsfw('${s.id}', ${!s.is_nsfw})" title="${s.is_nsfw ? 'Remove NSFW' : 'Mark NSFW'}">
                                <i class="fa-solid fa-triangle-exclamation"></i> ${s.is_nsfw ? 'Un-NSFW' : 'NSFW'}
                            </button>
                            <button class="btn btn-small ${s.force_vod_recording_disabled ? 'btn-success' : 'btn-warning'}" onclick="adminSetUserForcedVodRecording('${s.user_id}', ${s.force_vod_recording_disabled ? 'false' : 'true'})">
                                <i class="fa-solid ${s.force_vod_recording_disabled ? 'fa-power-off' : 'fa-hdd'}"></i>
                                ${s.force_vod_recording_disabled ? 'Allow VOD' : 'Force Off VOD'}
                            </button>
                            <button class="btn btn-small btn-danger" onclick="forceEndStream('${s.id}')">
                                <i class="fa-solid fa-stop"></i> End
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function forceEndStream(streamId) {
    if (!confirm('Force end this stream?')) return;
    try {
        await api(`/admin/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'success');
        loadAdminStreams();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

async function adminToggleStreamNsfw(streamId, isNsfw) {
    try {
        await api(`/admin/streams/${streamId}/nsfw`, { method: 'PUT', body: { is_nsfw: isNsfw } });
        toast(isNsfw ? 'Stream marked as NSFW' : 'NSFW removed', 'success');
        loadAdminStreams();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Cashouts ─────────────────────────────────────────────────── */
async function loadAdminCashouts() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/funds/cashouts/pending');
        const cashouts = data.cashouts || [];
        if (!cashouts.length) { c.innerHTML = '<p class="muted">No pending cashouts</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>Amount</th><th>USD</th><th>PayPal</th><th>Requested</th><th>Actions</th>
                </tr></thead>
                <tbody>${cashouts.map(co => `
                    <tr>
                        <td>${esc(co.username || '-')}</td>
                        <td>${Number(co.amount).toLocaleString()} Vibes</td>
                        <td>$${(co.amount * 0.01).toFixed(2)}</td>
                        <td>${esc(co.paypal_email || '-')}</td>
                        <td>${new Date(co.created_at).toLocaleString()}</td>
                        <td>
                            <button class="btn btn-small btn-success" onclick="approveCashout('${co.id}')">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button class="btn btn-small btn-danger" onclick="denyCashout('${co.id}')">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function approveCashout(cashoutId) {
    try {
        await api(`/funds/cashout/${cashoutId}/approve`, { method: 'POST' });
        toast('Cashout approved', 'success');
        loadAdminCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

async function denyCashout(cashoutId) {
    const reason = prompt('Denial reason:');
    if (reason === null) return;
    try {
        await api(`/funds/cashout/${cashoutId}/deny`, { method: 'POST', body: { reason } });
        toast('Cashout denied & refunded', 'info');
        loadAdminCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Bans ──────────────────────────────────────────────────────── */
async function loadAdminBans() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/bans');
        const bans = data.bans || [];
        if (!bans.length) { c.innerHTML = '<p class="muted">No active bans</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>Reason</th><th>Banned At</th><th>Expires</th><th>Actions</th>
                </tr></thead>
                <tbody>${bans.map(b => `
                    <tr>
                        <td>${esc(b.username || b.user_id)}</td>
                        <td>${esc(b.reason || '-')}</td>
                        <td>${new Date(b.created_at).toLocaleString()}</td>
                        <td>${b.expires_at ? new Date(b.expires_at).toLocaleString() : 'Permanent'}</td>
                        <td>
                            <button class="btn btn-small btn-outline" onclick="unbanUser('${b.user_id}')">
                                <i class="fa-solid fa-user-check"></i> Unban
                            </button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function unbanUser(userId) {
    try {
        await api(`/admin/users/${userId}/ban`, { method: 'DELETE' });
        toast('User unbanned', 'success');
        loadAdminBans();
        loadAdminStats();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VPN Queue ────────────────────────────────────────────────── */
async function loadAdminVPN() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const data = await api('/admin/vpn-queue');
        const queue = data.queue || [];
        if (!queue.length) { c.innerHTML = '<p class="muted">VPN approval queue empty</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>IP</th><th>Reason</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>${queue.map(q => `
                    <tr>
                        <td>${esc(q.username || q.user_id)}</td>
                        <td>${esc(q.ip_address || '-')}</td>
                        <td>${esc(q.reason || '-')}</td>
                        <td>${esc(q.status)}</td>
                        <td>
                            ${q.status === 'pending' ? `
                                <button class="btn btn-small btn-success" onclick="approveVPN('${q.id}')">
                                    <i class="fa-solid fa-check"></i>
                                </button>
                                <button class="btn btn-small btn-danger" onclick="denyVPN('${q.id}')">
                                    <i class="fa-solid fa-times"></i>
                                </button>
                            ` : esc(q.status)}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function approveVPN(id) {
    try {
        await api(`/admin/vpn-queue/${id}`, { method: 'PUT', body: { status: 'approved' } });
        toast('VPN approved', 'success');
        loadAdminVPN();
    } catch (e) { toast(e.message, 'error'); }
}

async function denyVPN(id) {
    try {
        await api(`/admin/vpn-queue/${id}`, { method: 'PUT', body: { status: 'denied' } });
        toast('VPN denied', 'info');
        loadAdminVPN();
    } catch (e) { toast(e.message, 'error'); }
}

/* ── TTS Admin Panel ──────────────────────────────────────────── */
async function loadAdminTTS() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading TTS settings...</p>';
    try {
        const [settingsRes, voicesRes] = await Promise.all([
            api('/tts/admin/settings'),
            api('/tts/voices'),
        ]);
        const s = settingsRes.settings || {};
        const voices = voicesRes.voices || [];

        // Build voice options for default voice selector
        const espeakVoices = voices.filter(v => v.engine === 'espeak-ng');
        const googleVoices = voices.filter(v => v.engine === 'google-cloud');
        const pollyVoices = voices.filter(v => v.engine === 'amazon-polly');

        const voiceOptions = (arr) => arr.map(v =>
            `<option value="${esc(v.id)}" ${v.id === s.defaultVoice ? 'selected' : ''}>${esc(v.name)} (${esc(v.rarity)})${v.available ? '' : ' ⚠️ unavailable'}</option>`
        ).join('');

        c.innerHTML = `
            <form id="admin-tts-form" style="display:grid;gap:16px;max-width:700px">
                <h3 style="margin:0"><i class="fa-solid fa-comment-dots"></i> TTS Configuration</h3>

                <div class="bc-settings-group" style="padding:12px;border:1px solid var(--border);border-radius:8px">
                    <div class="bc-settings-title" style="margin-bottom:8px"><i class="fa-solid fa-sliders"></i> General</div>
                    <div style="display:grid;gap:10px">
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">TTS Enabled</strong>
                            <input type="checkbox" id="tts-admin-enabled" ${s.enabled ? 'checked' : ''} style="width:18px;height:18px">
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">Default Provider</strong>
                            <select id="tts-admin-provider" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                <option value="espeak-ng" ${s.provider === 'espeak-ng' ? 'selected' : ''}>espeak-ng (Local/Free)</option>
                                <option value="google-cloud" ${s.provider === 'google-cloud' ? 'selected' : ''}>Google Cloud TTS</option>
                                <option value="amazon-polly" ${s.provider === 'amazon-polly' ? 'selected' : ''}>Amazon Polly</option>
                            </select>
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">Default Voice</strong>
                            <select id="tts-admin-default-voice" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                <optgroup label="espeak-ng">${voiceOptions(espeakVoices)}</optgroup>
                                <optgroup label="Google Cloud">${voiceOptions(googleVoices)}</optgroup>
                                <optgroup label="Amazon Polly">${voiceOptions(pollyVoices)}</optgroup>
                            </select>
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">Max Message Length</strong>
                            <input type="number" id="tts-admin-max-length" value="${s.maxLength || 200}" min="10" max="1000"
                                style="width:100px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">Max Queue Per User</strong>
                            <input type="number" id="tts-admin-max-per-user" value="${s.maxQueuePerUser || 3}" min="1" max="50"
                                style="width:100px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">Max Queue Global</strong>
                            <input type="number" id="tts-admin-max-global" value="${s.maxQueueGlobal || 20}" min="1" max="200"
                                style="width:100px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                        </label>
                    </div>
                </div>

                <div class="bc-settings-group" style="padding:12px;border:1px solid var(--border);border-radius:8px">
                    <div class="bc-settings-title" style="margin-bottom:8px"><i class="fa-brands fa-google"></i> Google Cloud TTS</div>
                    <div style="display:grid;gap:10px">
                        <label>
                            <strong>API Key</strong> <small class="muted">(simple auth — or use service account below)</small>
                            <div class="admin-sensitive-field">
                                <input type="password" id="tts-admin-google-api-key" value="${esc(s.googleApiKey || '')}" placeholder="AIza..." autocomplete="off" spellcheck="false"
                                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                <div class="admin-sensitive-actions">
                                    <button type="button" class="btn btn-small btn-outline" onclick="toggleAdminSensitiveInput('tts-admin-google-api-key', this)">
                                        <i class="fa-solid fa-eye"></i> Reveal
                                    </button>
                                    <button type="button" class="btn btn-small btn-outline" onclick="copyAdminSensitiveInput('tts-admin-google-api-key')">
                                        <i class="fa-solid fa-copy"></i> Copy
                                    </button>
                                </div>
                            </div>
                        </label>
                        <label>
                            <strong>Service Account JSON</strong> <small class="muted">(paste JSON or file path)</small>
                            <div class="admin-sensitive-field">
                                <textarea id="tts-admin-google-sa" rows="3" placeholder='{"type":"service_account","project_id":"...","private_key":"..."}' data-masked="true" readonly
                                    class="admin-sensitive-textarea is-masked"
                                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:12px">${esc(s.googleServiceAccount || '')}</textarea>
                                <div class="admin-sensitive-actions">
                                    <button type="button" class="btn btn-small btn-outline" onclick="toggleAdminSensitiveInput('tts-admin-google-sa', this)">
                                        <i class="fa-solid fa-eye"></i> Reveal
                                    </button>
                                    <button type="button" class="btn btn-small btn-outline" onclick="copyAdminSensitiveInput('tts-admin-google-sa')">
                                        <i class="fa-solid fa-copy"></i> Copy
                                    </button>
                                </div>
                            </div>
                        </label>
                    </div>
                </div>

                <div class="bc-settings-group" style="padding:12px;border:1px solid var(--border);border-radius:8px">
                    <div class="bc-settings-title" style="margin-bottom:8px"><i class="fa-brands fa-aws"></i> Amazon Polly</div>
                    <div style="display:grid;gap:10px">
                        <label>
                            <strong>AWS Access Key ID</strong>
                            <div class="admin-sensitive-field">
                                <input type="password" id="tts-admin-aws-key" value="${esc(s.awsAccessKeyId || '')}" placeholder="AKIA..." autocomplete="off" spellcheck="false"
                                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                <div class="admin-sensitive-actions">
                                    <button type="button" class="btn btn-small btn-outline" onclick="toggleAdminSensitiveInput('tts-admin-aws-key', this)">
                                        <i class="fa-solid fa-eye"></i> Reveal
                                    </button>
                                    <button type="button" class="btn btn-small btn-outline" onclick="copyAdminSensitiveInput('tts-admin-aws-key')">
                                        <i class="fa-solid fa-copy"></i> Copy
                                    </button>
                                </div>
                            </div>
                        </label>
                        <label>
                            <strong>AWS Secret Access Key</strong>
                            <div class="admin-sensitive-field">
                                <input type="password" id="tts-admin-aws-secret" value="${esc(s.awsSecretAccessKey || '')}" placeholder="wJalr..." autocomplete="off" spellcheck="false"
                                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                                <div class="admin-sensitive-actions">
                                    <button type="button" class="btn btn-small btn-outline" onclick="toggleAdminSensitiveInput('tts-admin-aws-secret', this)">
                                        <i class="fa-solid fa-eye"></i> Reveal
                                    </button>
                                    <button type="button" class="btn btn-small btn-outline" onclick="copyAdminSensitiveInput('tts-admin-aws-secret')">
                                        <i class="fa-solid fa-copy"></i> Copy
                                    </button>
                                </div>
                            </div>
                        </label>
                        <label style="display:flex;align-items:center;gap:12px">
                            <strong style="min-width:180px">AWS Region</strong>
                            <input type="text" id="tts-admin-aws-region" value="${esc(s.awsRegion || 'us-east-1')}" placeholder="us-east-1"
                                style="width:200px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                        </label>
                    </div>
                </div>

                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="submit" class="btn btn-primary" onclick="saveAdminTTS(event)">
                        <i class="fa-solid fa-floppy-disk"></i> Save TTS Settings
                    </button>
                    <button type="button" class="btn" onclick="testAdminTTSVoice()">
                        <i class="fa-solid fa-volume-high"></i> Test Voice
                    </button>
                </div>

                <div style="margin-top:8px">
                    <h4><i class="fa-solid fa-microphone"></i> Available Voices (${voices.length})</h4>
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;max-height:300px;overflow-y:auto;padding:4px">
                        ${voices.map(v => `
                            <div style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;opacity:${v.available ? '1' : '0.5'};font-size:13px">
                                <span>${v.emoji} <strong>${esc(v.name)}</strong></span>
                                <br><small class="muted">${esc(v.engine)} · ${esc(v.rarity)}</small>
                                ${!v.available ? '<br><small style="color:var(--warning)">⚠️ Not configured</small>' : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            </form>`;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error loading TTS settings: ${esc(e.message)}</p>`;
    }
}

async function saveAdminTTS(e) {
    if (e) e.preventDefault();
    try {
        const settings = {
            tts_enabled: document.getElementById('tts-admin-enabled').checked,
            tts_provider: document.getElementById('tts-admin-provider').value,
            tts_default_voice: document.getElementById('tts-admin-default-voice').value,
            tts_max_length: parseInt(document.getElementById('tts-admin-max-length').value) || 200,
            tts_max_queue_per_user: parseInt(document.getElementById('tts-admin-max-per-user').value) || 3,
            tts_max_queue_global: parseInt(document.getElementById('tts-admin-max-global').value) || 20,
            tts_google_api_key: document.getElementById('tts-admin-google-api-key').value,
            tts_google_service_account: document.getElementById('tts-admin-google-sa').value,
            tts_aws_access_key_id: document.getElementById('tts-admin-aws-key').value,
            tts_aws_secret_access_key: document.getElementById('tts-admin-aws-secret').value,
            tts_aws_region: document.getElementById('tts-admin-aws-region').value || 'us-east-1',
        };
        await api('/tts/admin/settings', { method: 'PUT', body: { settings } });
        toast('TTS settings saved', 'success');
    } catch (e) {
        toast('Error saving TTS: ' + e.message, 'error');
    }
}

async function testAdminTTSVoice() {
    try {
        const voiceId = document.getElementById('tts-admin-default-voice').value;
        const result = await api('/tts/admin/test', {
            method: 'POST',
            body: { voiceId, text: 'Hello, this is a TTS voice test from OpenVibe.Live.' },
        });
        if (result.audio && result.mimeType) {
            const binaryStr = atob(result.audio);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: result.mimeType });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = 0.8;
            audio.onended = () => URL.revokeObjectURL(url);
            audio.play();
            toast(`Testing: ${result.voiceName || voiceId} (${result.engine})`, 'info');
        } else {
            toast('No audio returned — check provider config', 'warning');
        }
    } catch (e) {
        toast('Test error: ' + e.message, 'error');
    }
}

/* ── Pastes Admin Tab ──────────────────────────────────────────── */
async function loadAdminPastes() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading paste stats...</p>';
    try {
        const [statsData, configData] = await Promise.all([
            api('/pastes/admin/stats'),
            api('/pastes/config'),
        ]);
        const s = statsData.stats || {};
        const cfg = configData || {};
        c.innerHTML = `
            <div class="admin-stats" style="margin-bottom:24px">
                ${[
                    { label: 'Total Pastes', value: s.total || 0, icon: 'fa-paste' },
                    { label: 'Text Pastes', value: s.textPastes || 0, icon: 'fa-code' },
                    { label: 'Screenshots', value: s.screenshots || 0, icon: 'fa-image' },
                    { label: 'Forks', value: s.forks || 0, icon: 'fa-code-fork' },
                    { label: 'Total Views', value: s.totalViews || 0, icon: 'fa-eye' },
                    { label: 'Total Copies', value: s.totalCopies || 0, icon: 'fa-copy' },
                    { label: 'Total Likes', value: s.totalLikes || 0, icon: 'fa-thumbs-up' },
                ].map(stat => `
                    <div class="admin-stat">
                        <div class="admin-stat-value">${typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}</div>
                        <div class="admin-stat-label"><i class="fa-solid ${stat.icon}"></i> ${stat.label}</div>
                    </div>
                `).join('')}
            </div>

            <h3 style="margin-bottom:12px;"><i class="fa-solid fa-sliders"></i> Paste Limits</h3>
            <form id="admin-paste-config-form" onsubmit="saveAdminPasteConfig(event)" style="display:grid;gap:10px;max-width:600px;margin-bottom:28px;">
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1" for="pcfg-max-size-kb">
                        <strong>Max paste size (KB)</strong>
                        <br><small class="muted">Maximum text content size for pastes</small>
                    </label>
                    <input type="number" id="pcfg-max-size-kb" value="${cfg.maxSizeKb || 512}" min="1" max="102400"
                        style="width:120px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                </div>
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1" for="pcfg-screenshot-max-mb">
                        <strong>Max image size (MB)</strong>
                        <br><small class="muted">Maximum upload size for screenshots / images</small>
                    </label>
                    <input type="number" id="pcfg-screenshot-max-mb" value="${cfg.screenshotMaxSizeMb || 8}" min="1" max="100"
                        style="width:120px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                </div>
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1" for="pcfg-cooldown">
                        <strong>Cooldown (seconds)</strong>
                        <br><small class="muted">Minimum seconds between submissions</small>
                    </label>
                    <input type="number" id="pcfg-cooldown" value="${cfg.cooldownSeconds || 30}" min="0" max="3600"
                        style="width:120px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                </div>
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1" for="pcfg-max-per-day">
                        <strong>Max per user per day</strong>
                        <br><small class="muted">0 = unlimited</small>
                    </label>
                    <input type="number" id="pcfg-max-per-day" value="${cfg.maxPerUserPerDay || 50}" min="0" max="10000"
                        style="width:120px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px">
                </div>
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1;cursor:pointer" for="pcfg-anon">
                        <strong>Allow anonymous pastes</strong>
                        <br><small class="muted">Let unauthenticated users create pastes</small>
                    </label>
                    <input type="checkbox" id="pcfg-anon" ${cfg.anonAllowed !== false ? 'checked' : ''}
                        style="width:18px;height:18px;cursor:pointer">
                </div>
                <div class="setting-row" style="display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)">
                    <label style="flex:1;cursor:pointer" for="pcfg-image-upload">
                        <strong>Allow image uploads</strong>
                        <br><small class="muted">Enable screenshot & image upload feature</small>
                    </label>
                    <input type="checkbox" id="pcfg-image-upload" ${cfg.imageUploadEnabled !== false ? 'checked' : ''}
                        style="width:18px;height:18px;cursor:pointer">
                </div>
                <button type="submit" class="btn btn-primary" style="justify-self:start;margin-top:4px">
                    <i class="fa-solid fa-floppy-disk"></i> Save Paste Settings
                </button>
            </form>

            <h3 style="margin-bottom:12px;"><i class="fa-solid fa-toolbox"></i> Actions</h3>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <button class="btn btn-danger" onclick="adminDeleteAllForks()">
                    <i class="fa-solid fa-code-fork"></i> Delete All Forks (${s.forks || 0})
                </button>
            </div>
        `;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

async function saveAdminPasteConfig(e) {
    e.preventDefault();
    const settings = {
        paste_max_size_kb: document.getElementById('pcfg-max-size-kb').value,
        paste_screenshot_max_size_mb: document.getElementById('pcfg-screenshot-max-mb').value,
        paste_cooldown_seconds: document.getElementById('pcfg-cooldown').value,
        paste_max_per_user_per_day: document.getElementById('pcfg-max-per-day').value,
        paste_anon_allowed: document.getElementById('pcfg-anon').checked ? 'true' : 'false',
        paste_image_upload_enabled: document.getElementById('pcfg-image-upload').checked ? 'true' : 'false',
    };
    try {
        await api('/admin/settings', { method: 'PUT', body: { settings } });
        toast('Paste settings saved', 'success');
    } catch (err) {
        toast(err.message || 'Failed to save paste settings', 'error');
    }
}

async function adminDeleteAllForks() {
    if (!confirm('Delete ALL forked pastes? This cannot be undone.')) return;
    try {
        const data = await api('/pastes/admin/forks', { method: 'DELETE' });
        toast(`Deleted ${data.deleted || 0} forked paste(s)`, 'success');
        loadAdminPastes(); // Refresh stats
    } catch (e) {
        toast(e.message || 'Failed to delete forks', 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   Data / Storage Management Tab
   ═══════════════════════════════════════════════════════════════ */

function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function storagePctClass(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 75) return 'warning';
    return 'ok';
}

function fmtDuration(sec) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

async function loadAdminData() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Analyzing storage...</p>';
    try {
        const [data, tierData] = await Promise.all([
            api('/admin/storage'),
            api('/admin/storage/tiers').catch(() => null),
        ]);
        const d = data.disk || {};
        const usePct = d.total ? ((d.used / d.total) * 100).toFixed(1) : 0;
        const dataPct = d.total ? ((data.dataTotal.bytes / d.total) * 100).toFixed(1) : 0;
        const pctClass = storagePctClass(parseFloat(usePct));

        // Sort breakdown by size descending
        const breakdown = (data.breakdown || []).sort((a, b) => b.bytes - a.bytes);
        const maxBreakdown = Math.max(...breakdown.map(b => b.bytes), 1);

        // Storage tiers — Local / Backblaze B2 / Cloudflare R2 breakdown
        let tierHtml = '';
        if (tierData) {
            const t = tierData.tiers || {};
            const ct = tierData.clipTiers || {};
            const prov = tierData.providers || {};
            const ts = tierData.settings || {};
            const L = t.local || { count: 0, bytes: 0 };
            const B = t.b2 || { count: 0, bytes: 0 };
            const R = t.r2 || { count: 0, bytes: 0 };
            const totalBytes = (L.bytes || 0) + (B.bytes || 0) + (R.bytes || 0);
            const totalVods = (L.count || 0) + (B.count || 0) + (R.count || 0);
            const totalClips = ((ct.local?.count) || 0) + ((ct.b2?.count) || 0) + ((ct.r2?.count) || 0);
            const offloadedBytes = (B.bytes || 0) + (R.bytes || 0);
            const offloadPct = totalBytes > 0 ? ((offloadedBytes / totalBytes) * 100).toFixed(1) : '0.0';
            const pctOf = (b) => totalBytes > 0 ? (b / totalBytes) * 100 : 0;

            const providerStatus = (p) => {
                if (!p) return '<span class="muted">—</span>';
                if (!p.configured) return '<span style="color:#9aa4b8">not configured</span>';
                return p.healthy
                    ? `<span style="color:#22c55e"><i class="fa-solid fa-circle-check"></i> healthy</span>${p.bucket ? ` <span class="muted" style="font-size:11px">· ${esc(p.bucket)}</span>` : ''}`
                    : `<span style="color:#ef4444"><i class="fa-solid fa-circle-xmark"></i> error</span>`;
            };

            const rows = [
                { label: 'Local (SSD)',    icon: 'fa-hard-drive',  color: '#f59e0b', v: L, clips: (ct.local?.count) || 0, status: '<span class="muted">primary disk</span>' },
                { label: 'Backblaze B2',   icon: 'fa-box-archive', color: '#e21e2b', v: B, clips: (ct.b2?.count) || 0,    status: providerStatus(prov.b2) },
                { label: 'Cloudflare R2',  icon: 'fa-cloud',       color: '#f6821f', v: R, clips: (ct.r2?.count) || 0,    status: providerStatus(prov.r2) },
            ];

            const bar = `<div style="display:flex;height:16px;border-radius:8px;overflow:hidden;margin:6px 0 16px;background:var(--bg-secondary)">
                <div title="Local ${pctOf(L.bytes).toFixed(1)}%" style="width:${pctOf(L.bytes)}%;background:#f59e0b"></div>
                <div title="B2 ${pctOf(B.bytes).toFixed(1)}%" style="width:${pctOf(B.bytes)}%;background:#e21e2b"></div>
                <div title="R2 ${pctOf(R.bytes).toFixed(1)}%" style="width:${pctOf(R.bytes)}%;background:#f6821f"></div>
            </div>`;

            const rowHtml = rows.map(r => `
                <tr>
                    <td style="padding:8px 10px"><i class="fa-solid ${r.icon}" style="color:${r.color}"></i> <strong>${r.label}</strong></td>
                    <td style="padding:8px 10px;text-align:right">${(r.v.count || 0).toLocaleString()}</td>
                    <td style="padding:8px 10px;text-align:right">${fmtBytes(r.v.bytes || 0)}</td>
                    <td style="padding:8px 10px;text-align:right">${pctOf(r.v.bytes).toFixed(1)}%</td>
                    <td style="padding:8px 10px;text-align:right">${(r.clips || 0).toLocaleString()}</td>
                    <td style="padding:8px 10px">${r.status}</td>
                </tr>`).join('');

            tierHtml = `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:28px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
                    <h3 style="margin:0"><i class="fa-solid fa-layer-group"></i> Storage Tiers <span class="muted" style="font-size:13px;font-weight:400">— ${offloadPct}% of VOD data offloaded to cloud</span></h3>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-outline btn-sm" onclick="adminRunSweep()"><i class="fa-solid fa-broom"></i> Run Sweep</button>
                        <button class="btn btn-outline btn-sm" onclick="adminEditTierSettings()"><i class="fa-solid fa-gear"></i> Settings</button>
                    </div>
                </div>
                ${bar}
                <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <thead>
                        <tr style="text-align:left;color:var(--text-secondary);border-bottom:1px solid var(--border)">
                            <th style="padding:6px 10px">Tier</th>
                            <th style="padding:6px 10px;text-align:right">VODs</th>
                            <th style="padding:6px 10px;text-align:right">VOD Size</th>
                            <th style="padding:6px 10px;text-align:right">Share</th>
                            <th style="padding:6px 10px;text-align:right">Clips</th>
                            <th style="padding:6px 10px">Provider</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowHtml}
                        <tr style="border-top:2px solid var(--border);font-weight:700">
                            <td style="padding:8px 10px">Total</td>
                            <td style="padding:8px 10px;text-align:right">${totalVods.toLocaleString()}</td>
                            <td style="padding:8px 10px;text-align:right">${fmtBytes(totalBytes)}</td>
                            <td style="padding:8px 10px;text-align:right">100%</td>
                            <td style="padding:8px 10px;text-align:right">${totalClips.toLocaleString()}</td>
                            <td style="padding:8px 10px">${tierData.sweepRunning ? '<span style="color:#f59e0b"><i class="fa-solid fa-spinner fa-spin"></i> sweeping</span>' : '<span class="muted">idle</span>'}</td>
                        </tr>
                    </tbody>
                </table>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--text-secondary);margin-top:14px">
                    <span title="Auto-migration enabled"><i class="fa-solid ${ts.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}" style="color:${ts.enabled ? '#22c55e' : '#ef4444'}"></i> Auto-offload: ${ts.enabled ? 'ON' : 'OFF'}</span>
                    <span>| Age ≥ ${ts.minAgeDays ?? '?'}d</span>
                    <span>| Views ≤ ${ts.maxViewsForCold ?? '?'}</span>
                    <span>| Idle ≥ ${ts.minLastAccessDays ?? '?'}d</span>
                    <span>| Sweep every ${ts.sweepIntervalMs ? (ts.sweepIntervalMs / 60000).toFixed(0) + ' min' : '?'}</span>
                    <span>| Max ${ts.maxPerSweep ?? '?'}/sweep</span>
                </div>
            </div>`;
        }

        c.innerHTML = `
            <!-- Storage Tiers -->
            ${tierHtml}

            <!-- Disk Overview -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">
                <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px">
                    <h3 style="margin-bottom:14px;"><i class="fa-solid fa-hard-drive"></i> Disk Usage</h3>
                    <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px">
                        <span>${fmtBytes(d.used)} used of ${fmtBytes(d.total)}</span>
                        <span class="storage-pct-${pctClass}" style="font-weight:700">${usePct}%</span>
                    </div>
                    <div style="background:var(--bg-tertiary);border-radius:6px;height:18px;overflow:hidden;position:relative">
                        <div style="background:var(--storage-bar-${pctClass}, var(--accent));height:100%;width:${usePct}%;border-radius:6px;transition:width .5s"></div>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px;color:var(--text-secondary)">
                        <span><i class="fa-solid fa-check-circle"></i> ${fmtBytes(d.available)} available</span>
                        <span>Mount: ${esc(d.mount || '/')}</span>
                    </div>
                    ${parseFloat(usePct) >= 85 ? `<div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);font-size:13px;color:#f87171"><i class="fa-solid fa-triangle-exclamation"></i> <strong>Warning:</strong> Disk usage is ${usePct}%. Consider cleaning up old VODs or expanding storage.</div>` : ''}
                </div>
                <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px">
                    <h3 style="margin-bottom:14px;"><i class="fa-solid fa-database"></i> Data Summary</h3>
                    <div class="admin-stats" style="margin:0">
                        ${[
                            { label: 'Total Data', value: fmtBytes(data.dataTotal?.bytes || 0), icon: 'fa-folder-open' },
                            { label: 'Files', value: (data.dataTotal?.files || 0).toLocaleString(), icon: 'fa-file' },
                            { label: 'Database', value: fmtBytes(data.database?.bytes || 0), icon: 'fa-database' },
                            { label: 'Data % of Disk', value: dataPct + '%', icon: 'fa-chart-pie' },
                            { label: 'VODs (DB)', value: (data.vodStats?.count || 0).toLocaleString(), icon: 'fa-video' },
                            { label: 'Clips (DB)', value: (data.clipStats?.count || 0).toLocaleString(), icon: 'fa-film' },
                        ].map(s => `
                            <div class="admin-stat">
                                <div class="admin-stat-value">${s.value}</div>
                                <div class="admin-stat-label"><i class="fa-solid ${s.icon}"></i> ${s.label}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <!-- Per-directory breakdown -->
            <h3 style="margin-bottom:14px;"><i class="fa-solid fa-folder-tree"></i> Storage Breakdown</h3>
            <div style="display:grid;gap:8px;margin-bottom:28px">
                ${breakdown.map(b => {
                    const pct = maxBreakdown > 0 ? ((b.bytes / maxBreakdown) * 100).toFixed(1) : 0;
                    return `
                        <div style="display:grid;grid-template-columns:140px 1fr 100px 80px;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px">
                            <span style="font-weight:600;font-size:14px"><i class="fa-solid ${b.icon}" style="width:20px;text-align:center;margin-right:6px;color:var(--accent)"></i>${esc(b.name)}</span>
                            <div style="background:var(--bg-tertiary);border-radius:4px;height:12px;overflow:hidden">
                                <div style="background:var(--accent);height:100%;width:${pct}%;border-radius:4px;transition:width .4s"></div>
                            </div>
                            <span style="text-align:right;font-weight:600;font-size:13px">${fmtBytes(b.bytes)}</span>
                            <span style="text-align:right;font-size:12px;color:var(--text-muted)">${b.files.toLocaleString()} files</span>
                        </div>
                    `;
                }).join('')}
                <div style="display:grid;grid-template-columns:140px 1fr 100px 80px;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px">
                    <span style="font-weight:600;font-size:14px"><i class="fa-solid fa-database" style="width:20px;text-align:center;margin-right:6px;color:var(--accent)"></i>Database</span>
                    <div style="background:var(--bg-tertiary);border-radius:4px;height:12px;overflow:hidden">
                        <div style="background:var(--accent);height:100%;width:${maxBreakdown > 0 ? (((data.database?.bytes || 0) / maxBreakdown) * 100).toFixed(1) : 0}%;border-radius:4px"></div>
                    </div>
                    <span style="text-align:right;font-weight:600;font-size:13px">${fmtBytes(data.database?.bytes || 0)}</span>
                    <span style="text-align:right;font-size:12px;color:var(--text-muted)">1 file</span>
                </div>
            </div>

            <!-- Cloud storage (B2 / R2) usage + estimated cost (loaded async — bucket scan is slow) -->
            <div id="admin-cloud-storage" style="margin-bottom:28px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                    <h3 style="margin:0"><i class="fa-solid fa-cloud"></i> Cloud Storage — B2 &amp; R2 Usage &amp; Cost</h3>
                    <button class="btn btn-outline btn-sm" onclick="_loadCloudStorageUsage(true)"><i class="fa-solid fa-rotate"></i> Rescan</button>
                </div>
                <p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Scanning cloud buckets…</p>
            </div>

            <!-- VOD Management -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                <h3><i class="fa-solid fa-video"></i> VOD Management</h3>
                <div style="display:flex;gap:8px">
                    <select id="admin-vod-sort" onchange="loadAdminVodTable()" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:13px">
                        <option value="size">Sort by Size</option>
                        <option value="date">Sort by Date</option>
                        <option value="duration">Sort by Duration</option>
                        <option value="views">Sort by Views</option>
                        <option value="tier">Sort by Tier</option>
                        <option value="accessed">Sort by Last Access</option>
                        <option value="user">Sort by User</option>
                    </select>
                    <button class="btn btn-sm" onclick="adminBulkMoveVods('cold')" id="admin-vod-cold-btn" disabled style="background:rgba(56,189,248,0.15);color:#38bdf8;border:1px solid rgba(56,189,248,0.3)">
                        <i class="fa-solid fa-snowflake"></i> Move to Cold
                    </button>
                    <button class="btn btn-sm" onclick="adminBulkMoveVods('hot')" id="admin-vod-hot-btn" disabled style="background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)">
                        <i class="fa-solid fa-bolt"></i> Move to Hot
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="adminBulkDeleteVods()" id="admin-vod-bulk-btn" disabled>
                        <i class="fa-solid fa-trash-can"></i> Delete Selected
                    </button>
                </div>
            </div>
            <div id="admin-vod-table"><p class="muted">Loading VODs...</p></div>
        `;

        // Add CSS variables for storage bar colors
        const style = document.createElement('style');
        style.textContent = `
            :root { --storage-bar-ok: #22c55e; --storage-bar-warning: #f59e0b; --storage-bar-danger: #ef4444; }
            .storage-pct-ok { color: #22c55e; } .storage-pct-warning { color: #f59e0b; } .storage-pct-danger { color: #ef4444; }
        `;
        if (!document.getElementById('admin-storage-styles')) { style.id = 'admin-storage-styles'; document.head.appendChild(style); }

        loadAdminVodTable();
        _loadCloudStorageUsage();
    } catch (e) {
        c.innerHTML = `<p class="muted">Error loading storage data: ${esc(e.message)}</p>`;
    }
}

/** Load real B2/R2 bucket usage + estimated cost into #admin-cloud-storage (slow scan). */
async function _loadCloudStorageUsage(force = false) {
    const el = document.getElementById('admin-cloud-storage');
    if (!el) return;
    const header = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <h3 style="margin:0"><i class="fa-solid fa-cloud"></i> Cloud Storage — B2 &amp; R2 Usage &amp; Cost</h3>
            <button class="btn btn-outline btn-sm" onclick="_loadCloudStorageUsage(true)"><i class="fa-solid fa-rotate"></i> Rescan</button>
        </div>`;
    el.innerHTML = header + '<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Scanning cloud buckets…</p>';
    try {
        const data = await api(`/admin/storage/buckets${force ? '?force=1' : ''}`);
        const usage = data.usage || {};
        const costs = data.costs || {};
        const money = (n) => '$' + (Number(n) || 0).toFixed(2);

        const providerCard = (key, label, color) => {
            const u = usage[key];
            const c = costs[key];
            if (!u || u.configured === false) {
                return `<div style="flex:1;min-width:260px;background:var(--bg-tertiary);border-radius:10px;padding:16px">
                    <strong style="color:${color}"><i class="fa-solid fa-cloud"></i> ${label}</strong>
                    <div class="muted" style="margin-top:8px">Not configured</div></div>`;
            }
            if (u.error) {
                return `<div style="flex:1;min-width:260px;background:var(--bg-tertiary);border-radius:10px;padding:16px">
                    <strong style="color:${color}"><i class="fa-solid fa-cloud"></i> ${label}</strong>
                    <div style="color:#ef4444;margin-top:8px">Scan error: ${esc(u.error)}</div></div>`;
            }
            const topPrefixes = Object.entries(u.prefixes || {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
            const prefixRows = topPrefixes.map(([p, v]) => `
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);padding:2px 0">
                    <span>${esc(p)}</span><span>${fmtBytes(v.bytes)} · ${v.objects.toLocaleString()}</span>
                </div>`).join('');
            return `<div style="flex:1;min-width:260px;background:var(--bg-tertiary);border-radius:10px;padding:16px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                    <strong style="color:${color}"><i class="fa-solid fa-cloud"></i> ${label}</strong>
                    <span class="muted" style="font-size:12px">${esc(u.bucket || '')}</span>
                </div>
                <div style="display:flex;gap:16px;margin-bottom:10px">
                    <div><div style="font-size:20px;font-weight:700">${fmtBytes(u.bytes)}</div><div class="muted" style="font-size:11px">${u.objects.toLocaleString()} objects</div></div>
                    <div><div style="font-size:20px;font-weight:700;color:${color}">${c ? money(c.storageMonthly) : '—'}<span style="font-size:12px;font-weight:400" class="muted">/mo</span></div><div class="muted" style="font-size:11px">storage @ $${c ? c.storagePerGbMonth : '?'}/GB</div></div>
                </div>
                <div class="muted" style="font-size:11px;margin-bottom:6px">Egress: ${c ? esc(c.egressNote) : '—'}</div>
                ${prefixRows ? `<div style="border-top:1px solid var(--border);padding-top:6px">${prefixRows}</div>` : ''}
            </div>`;
        };

        el.innerHTML = header + `
            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
                ${providerCard('b2', 'Backblaze B2', '#e21e2b')}
                ${providerCard('r2', 'Cloudflare R2', '#f6821f')}
            </div>
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
                <span><i class="fa-solid fa-file-invoice-dollar" style="color:var(--accent)"></i> <strong>Estimated cloud storage cost</strong> <span class="muted" style="font-size:12px">(list prices; excludes egress/operations)</span></span>
                <span style="font-size:22px;font-weight:800;color:var(--accent)">${money(costs.totalStorageMonthly)}<span style="font-size:13px;font-weight:400" class="muted">/mo</span></span>
            </div>`;
    } catch (e) {
        el.innerHTML = header + `<p class="muted" style="color:#ef4444">Failed to scan buckets: ${esc(e.message)}</p>`;
    }
}

async function loadAdminVodTable() {
    const container = document.getElementById('admin-vod-table');
    if (!container) return;
    const sort = document.getElementById('admin-vod-sort')?.value || 'size';
    container.innerHTML = '<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</p>';

    try {
        const data = await api(`/admin/storage/vods?sort=${sort}&order=desc&limit=100`);
        const vods = data.vods || [];
        const userSummary = data.userSummary || [];

        if (vods.length === 0) {
            container.innerHTML = '<p class="muted">No VODs found.</p>';
            return;
        }

        let html = '';

        // User summary
        if (userSummary.length > 0) {
            html += `<div style="margin-bottom:18px;padding:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px">
                <strong style="font-size:13px;color:var(--text-secondary)"><i class="fa-solid fa-users"></i> Top Users by Storage</strong>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
                    ${userSummary.slice(0, 10).map(u => `
                        <span style="background:var(--bg-tertiary);padding:4px 10px;border-radius:6px;font-size:12px">
                            <strong>${esc(u.username)}</strong>: ${fmtBytes(u.totalSize)} (${u.vodCount} VODs)
                        </span>
                    `).join('')}
                </div>
            </div>`;
        }

        // VOD table
        html += `<div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                    <tr style="border-bottom:2px solid var(--border);text-align:left">
                        <th style="padding:8px 6px;width:32px"><input type="checkbox" id="admin-vod-select-all" onchange="adminToggleAllVods(this.checked)" style="cursor:pointer"></th>
                        <th style="padding:8px 6px">Title</th>
                        <th style="padding:8px 6px">User</th>
                        <th style="padding:8px 6px;text-align:right">Size</th>
                        <th style="padding:8px 6px;text-align:right">Views</th>
                        <th style="padding:8px 6px;text-align:right">Duration</th>
                        <th style="padding:8px 6px">Date</th>
                        <th style="padding:8px 6px;text-align:center">Tier</th>
                        <th style="padding:8px 6px;text-align:center">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${vods.map(v => {
                        const age = v.created_at ? timeAgo(v.created_at) : '—';
                        const tier = v.actualTier || v.storage_tier || 'hot';
                        const tierBadge = tier === 'cold'
                            ? '<span style="background:rgba(56,189,248,0.15);color:#38bdf8;padding:2px 6px;border-radius:4px;font-size:11px"><i class="fa-solid fa-snowflake"></i> Cold</span>'
                            : tier === 'missing'
                            ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:4px;font-size:11px"><i class="fa-solid fa-ghost"></i> Missing</span>'
                            : '<span style="background:rgba(245,158,11,0.15);color:#f59e0b;padding:2px 6px;border-radius:4px;font-size:11px"><i class="fa-solid fa-bolt"></i> Hot</span>';
                        const statusIcons = [
                            v.is_recording ? '<i class="fa-solid fa-circle" style="color:#ef4444" title="Recording"></i>' : '',
                            v.is_public ? '<i class="fa-solid fa-globe" style="color:#22c55e" title="Public"></i>' : '<i class="fa-solid fa-lock" style="color:#f59e0b" title="Private"></i>',
                            !v.fileExists ? '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444" title="File missing on disk!"></i>' : '',
                        ].filter(Boolean).join(' ');
                        return `
                            <tr style="border-bottom:1px solid var(--border)" data-vod-id="${v.id}">
                                <td style="padding:8px 6px"><input type="checkbox" class="admin-vod-cb" value="${v.id}" data-tier="${tier}" onchange="adminUpdateVodSelection()" style="cursor:pointer"></td>
                                <td style="padding:8px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.title || '')}">${esc(v.title || '(untitled)')}</td>
                                <td style="padding:8px 6px">${esc(v.username)}</td>
                                <td style="padding:8px 6px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmtBytes(v.diskSize || v.file_size || 0)}</td>
                                <td style="padding:8px 6px;text-align:right;color:var(--text-secondary)">${(v.view_count || 0).toLocaleString()}</td>
                                <td style="padding:8px 6px;text-align:right;color:var(--text-secondary)">${fmtDuration(v.duration_seconds)}</td>
                                <td style="padding:8px 6px;color:var(--text-secondary)" title="${esc(v.created_at || '')}">${age}</td>
                                <td style="padding:8px 6px;text-align:center">${tierBadge}</td>
                                <td style="padding:8px 6px;text-align:center">${statusIcons}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

        if (data.total > 100) {
            html += `<p class="muted" style="margin-top:12px;font-size:12px">Showing top 100 of ${data.total.toLocaleString()} VODs.</p>`;
        }

        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

function adminToggleAllVods(checked) {
    document.querySelectorAll('.admin-vod-cb').forEach(cb => { cb.checked = checked; });
    adminUpdateVodSelection();
}

function adminUpdateVodSelection() {
    const selected = [...document.querySelectorAll('.admin-vod-cb:checked')];
    const count = selected.length;
    const btn = document.getElementById('admin-vod-bulk-btn');
    const coldBtn = document.getElementById('admin-vod-cold-btn');
    const hotBtn = document.getElementById('admin-vod-hot-btn');
    if (btn) {
        btn.disabled = count === 0;
        btn.innerHTML = count > 0
            ? `<i class="fa-solid fa-trash-can"></i> Delete Selected (${count})`
            : '<i class="fa-solid fa-trash-can"></i> Delete Selected';
    }
    if (coldBtn) {
        const hotCount = selected.filter(cb => cb.dataset.tier === 'hot').length;
        coldBtn.disabled = hotCount === 0;
        coldBtn.innerHTML = hotCount > 0
            ? `<i class="fa-solid fa-snowflake"></i> Move to Cold (${hotCount})`
            : '<i class="fa-solid fa-snowflake"></i> Move to Cold';
    }
    if (hotBtn) {
        const coldCount = selected.filter(cb => cb.dataset.tier === 'cold').length;
        hotBtn.disabled = coldCount === 0;
        hotBtn.innerHTML = coldCount > 0
            ? `<i class="fa-solid fa-bolt"></i> Move to Hot (${coldCount})`
            : '<i class="fa-solid fa-bolt"></i> Move to Hot';
    }
}

async function adminBulkDeleteVods() {
    const ids = [...document.querySelectorAll('.admin-vod-cb:checked')].map(cb => parseInt(cb.value));
    if (ids.length === 0) return;
    if (!confirm(`Permanently delete ${ids.length} VOD(s) and their files from disk? This cannot be undone.`)) return;

    try {
        const data = await api('/admin/storage/vods/bulk', { method: 'DELETE', body: { ids } });
        const msg = `Deleted ${data.deleted} VOD(s), freed ${fmtBytes(data.freed || 0)}`;
        toast(msg, 'success');
        if (data.errors?.length) {
            console.warn('[Admin] Bulk delete errors:', data.errors);
            toast(`${data.errors.length} error(s) during deletion`, 'warning');
        }
        // Refresh both the overview and VOD table
        loadAdminData();
    } catch (e) {
        toast(e.message || 'Bulk delete failed', 'error');
    }
}

async function adminRunSweep() {
    const btn = event?.target?.closest?.('button');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…'; }
    try {
        const data = await api('/admin/storage/tiers/sweep', { method: 'POST' });
        const msg = data.moved > 0
            ? `Sweep complete: moved ${data.moved} VOD(s) to cold storage, freed ${fmtBytes(data.freedBytes || 0)} on hot`
            : 'Sweep complete: no VODs eligible for migration';
        toast(msg, data.moved > 0 ? 'success' : 'info');
        if (data.errors?.length) toast(`${data.errors.length} error(s) during sweep`, 'warning');
        loadAdminData();
    } catch (e) {
        toast(e.message || 'Sweep failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-broom"></i> Run Sweep Now'; }
    }
}

async function adminEditTierSettings() {
    // Fetch current settings
    let tierStatus;
    try {
        tierStatus = await api('/admin/storage/tiers');
    } catch (e) {
        toast(e.message || 'Failed to load tier settings', 'error');
        return;
    }
    const s = tierStatus.settings || {};

    // Build a simple modal
    const overlay = document.createElement('div');
    overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';
    overlay.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3)">
            <h3 style="margin:0 0 16px;font-size:1.1rem"><i class="fa-solid fa-sliders"></i> Storage Tier Settings</h3>
            <div style="display:grid;gap:10px;font-size:0.9rem">
                <label style="display:flex;align-items:center;gap:8px">
                    <input type="checkbox" id="ts-enabled" ${s.enabled !== false ? 'checked' : ''}>
                    <span>Auto-sweep enabled</span>
                </label>
                <label style="display:grid;gap:2px">
                    <span>Min age (days) before cold migration</span>
                    <input type="number" id="ts-minAge" value="${s.minAgeDays ?? 7}" min="1" max="365" style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                </label>
                <label style="display:grid;gap:2px">
                    <span>Max view count for cold eligibility</span>
                    <input type="number" id="ts-maxViews" value="${s.maxViewsForCold ?? 5}" min="0" max="10000" style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                </label>
                <label style="display:grid;gap:2px">
                    <span>Min days since last access</span>
                    <input type="number" id="ts-minAccess" value="${s.minLastAccessDays ?? 3}" min="1" max="365" style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                </label>
                <label style="display:grid;gap:2px">
                    <span>Max VODs per sweep</span>
                    <input type="number" id="ts-maxPerSweep" value="${s.maxPerSweep ?? 10}" min="1" max="100" style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                </label>
                <label style="display:grid;gap:2px">
                    <span>Hot disk pressure threshold (%)</span>
                    <input type="number" id="ts-pressure" value="${s.hotDiskPressurePct ?? 80}" min="50" max="99" style="padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                </label>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-sm" id="ts-cancel" style="padding:6px 16px">Cancel</button>
                <button class="btn btn-primary btn-sm" id="ts-save" style="padding:6px 16px"><i class="fa-solid fa-check"></i> Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#ts-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#ts-save').onclick = async () => {
        const body = {
            enabled: document.getElementById('ts-enabled').checked,
            minAgeDays: parseInt(document.getElementById('ts-minAge').value) || 7,
            maxViewsForCold: parseInt(document.getElementById('ts-maxViews').value) || 5,
            minLastAccessDays: parseInt(document.getElementById('ts-minAccess').value) || 3,
            maxPerSweep: parseInt(document.getElementById('ts-maxPerSweep').value) || 10,
            hotDiskPressurePct: parseInt(document.getElementById('ts-pressure').value) || 80,
        };
        try {
            await api('/admin/storage/tiers/settings', { method: 'PUT', body });
            toast('Storage tier settings saved', 'success');
            overlay.remove();
            loadAdminData();
        } catch (e) {
            toast(e.message || 'Failed to save settings', 'error');
        }
    };
}

async function adminBulkMoveVods(target) {
    const allChecked = [...document.querySelectorAll('.admin-vod-cb:checked')];
    // Only move VODs that are on the opposite tier
    const ids = allChecked
        .filter(cb => target === 'cold' ? cb.dataset.tier === 'hot' : cb.dataset.tier === 'cold')
        .map(cb => parseInt(cb.value));
    if (ids.length === 0) {
        toast(`No selected VODs are eligible to move to ${target}`, 'warning');
        return;
    }
    const label = target === 'cold' ? 'cold (block storage)' : 'hot (primary SSD)';
    if (!confirm(`Move ${ids.length} VOD(s) to ${label}?`)) return;

    try {
        const data = await api('/admin/storage/tiers/bulk-move', { method: 'POST', body: { ids, target } });
        const msg = `Moved ${data.moved} of ${ids.length} VOD(s) to ${target}`;
        toast(msg, data.moved > 0 ? 'success' : 'info');
        if (data.errors?.length) {
            console.warn('[Admin] Bulk move errors:', data.errors);
            toast(`${data.errors.length} error(s) during move`, 'warning');
        }
        loadAdminData();
    } catch (e) {
        toast(e.message || 'Bulk move failed', 'error');
    }
}

/* ── Media Tools ──────────────────────────────────────────────── */
async function loadAdminMediaTools() {
    const c = document.getElementById('admin-content');
    c.innerHTML = '<p class="muted">Loading…</p>';

    let status = {};
    try {
        status = await api('/admin/media-tools/status');
    } catch (e) {
        c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
        return;
    }

    const potOk = status.pot_available;
    const cookiesOk = status.cookies_configured;
    const ytdlpOk = status.ytdlp_available;

    // Overall health
    let healthIcon, healthText, healthColor;
    if (ytdlpOk && cookiesOk && potOk) {
        healthIcon = 'fa-circle-check';
        healthText = 'All systems go — YouTube extraction should work.';
        healthColor = 'var(--success,#22c55e)';
    } else if (ytdlpOk && (cookiesOk || potOk)) {
        healthIcon = 'fa-triangle-exclamation';
        healthText = 'Partially configured — some YouTube videos may fail.';
        healthColor = 'var(--warning,#f59e0b)';
    } else if (ytdlpOk) {
        healthIcon = 'fa-circle-xmark';
        healthText = 'yt-dlp installed but cookies & PO Token provider are missing — YouTube will not work.';
        healthColor = 'var(--danger,#ef4444)';
    } else {
        healthIcon = 'fa-circle-xmark';
        healthText = 'yt-dlp is not installed — media requests are disabled.';
        healthColor = 'var(--danger,#ef4444)';
    }

    c.innerHTML = `
        <div style="display:grid;gap:16px;max-width:860px">
            <!-- Health banner -->
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;align-items:center;gap:12px">
                <i class="fa-solid ${healthIcon}" style="font-size:1.5rem;color:${healthColor}"></i>
                <div>
                    <div style="font-weight:600;font-size:0.95rem">${healthText}</div>
                    <div class="muted" style="font-size:0.8rem;margin-top:2px">Scroll down for setup guide if something is missing.</div>
                </div>
            </div>

            <!-- Status card -->
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px">
                <h3 style="margin:0 0 12px;font-size:1rem"><i class="fa-solid fa-wrench"></i> yt-dlp Status</h3>
                <div style="display:grid;gap:6px;font-size:0.9rem">
                    <div><strong>yt-dlp:</strong> ${ytdlpOk
                        ? '<span style="color:var(--success,#22c55e)"><i class="fa-solid fa-check-circle"></i> Installed</span>'
                        : '<span style="color:var(--danger,#ef4444)"><i class="fa-solid fa-xmark-circle"></i> Not found</span>'
                    }${status.ytdlp_version ? ' <span class="muted" style="font-size:0.82rem">v' + esc(status.ytdlp_version) + '</span>' : ''}</div>
                    <div><strong>Path:</strong> <code style="background:var(--bg-tertiary,var(--bg-input));padding:2px 6px;border-radius:4px;font-size:0.85rem">${esc(status.ytdlp_path)}</code></div>
                    <div><strong>Cookies:</strong> ${cookiesOk
                        ? '<span style="color:var(--success,#22c55e)"><i class="fa-solid fa-cookie"></i> Configured (' + status.cookies_size + ' bytes)</span>'
                        : '<span style="color:var(--danger,#ef4444)"><i class="fa-solid fa-cookie-bite"></i> Not configured</span>'
                    }</div>
                    <div><strong>PO Token Provider:</strong> ${potOk
                        ? '<span style="color:var(--success,#22c55e)"><i class="fa-solid fa-shield-check"></i> Available</span>'
                        : '<span style="color:var(--danger,#ef4444)"><i class="fa-solid fa-shield-xmark"></i> Not available</span>'
                    }</div>
                    ${(status.pot_providers || []).length > 0 ? '<div class="muted" style="font-size:0.8rem;padding-left:12px">' + esc(status.pot_providers.join(', ')) + '</div>' : ''}
                    <div><strong>Extra Args:</strong> ${status.extra_args_configured
                        ? '<span style="color:var(--success,#22c55e)"><i class="fa-solid fa-terminal"></i> Configured</span>'
                        : '<span class="muted"><i class="fa-solid fa-terminal"></i> None</span>'
                    }</div>
                </div>
            </div>

            <!-- Setup Guide -->
            <details style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px" ${(!ytdlpOk || !cookiesOk || !potOk) ? 'open' : ''}>
                <summary style="cursor:pointer;font-weight:600;font-size:1rem;display:flex;align-items:center;gap:8px">
                    <i class="fa-solid fa-book"></i> Setup Guide — How to Make YouTube Extraction Work
                </summary>
                <div style="margin-top:14px;font-size:0.87rem;line-height:1.6">
                    <p style="margin:0 0 10px">YouTube requires three things for server-side video extraction to work:</p>

                    <div style="background:var(--bg-tertiary,var(--bg-input));border-radius:6px;padding:14px;margin-bottom:14px">
                        <h4 style="margin:0 0 8px;font-size:0.92rem">
                            ${ytdlpOk ? '<i class="fa-solid fa-check-circle" style="color:var(--success,#22c55e)"></i>' : '<i class="fa-solid fa-circle" style="color:var(--danger,#ef4444)"></i>'}
                            Step 1: Install yt-dlp
                        </h4>
                        <p class="muted" style="margin:0 0 6px;font-size:0.82rem">
                            yt-dlp is the media extraction engine. Install it system-wide on your server.
                        </p>
                        <code style="display:block;background:var(--bg-primary);padding:8px 10px;border-radius:4px;font-size:0.8rem;white-space:pre-wrap">sudo pip3 install --break-system-packages yt-dlp</code>
                        <p class="muted" style="margin:6px 0 0;font-size:0.78rem">
                            Keep it updated regularly: <code>sudo pip3 install --break-system-packages --pre yt-dlp -U</code><br>
                            YouTube changes frequently — nightly builds often have fixes before stable releases.
                        </p>
                    </div>

                    <div style="background:var(--bg-tertiary,var(--bg-input));border-radius:6px;padding:14px;margin-bottom:14px">
                        <h4 style="margin:0 0 8px;font-size:0.92rem">
                            ${cookiesOk ? '<i class="fa-solid fa-check-circle" style="color:var(--success,#22c55e)"></i>' : '<i class="fa-solid fa-circle" style="color:var(--danger,#ef4444)"></i>'}
                            Step 2: YouTube Cookies
                        </h4>
                        <p class="muted" style="margin:0 0 6px;font-size:0.82rem">
                            YouTube blocks requests from servers without valid cookies. You need to export cookies from a logged-in browser session.
                        </p>
                        <ol style="margin:0;padding-left:20px;font-size:0.82rem" class="muted">
                            <li>Install the <strong>Get cookies.txt LOCALLY</strong> browser extension (Chrome/Firefox)</li>
                            <li>Open a <strong>private/incognito window</strong> and log into YouTube</li>
                            <li>Navigate to <code>https://www.youtube.com/robots.txt</code> (keep this as the only tab)</li>
                            <li>Click the extension icon → export YouTube cookies</li>
                            <li><strong>Close the incognito window immediately</strong> so the session is never rotated</li>
                            <li>Paste the exported cookies.txt content into the Cookies field below</li>
                        </ol>
                        <p style="margin:8px 0 0;font-size:0.78rem;color:var(--warning,#f59e0b)">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            Cookies expire! If extraction starts failing with "Sign in to confirm you're not a bot", you need to re-export fresh cookies.
                            Using a dedicated/throwaway Google account is recommended.
                        </p>
                    </div>

                    <div style="background:var(--bg-tertiary,var(--bg-input));border-radius:6px;padding:14px;margin-bottom:14px">
                        <h4 style="margin:0 0 8px;font-size:0.92rem">
                            ${potOk ? '<i class="fa-solid fa-check-circle" style="color:var(--success,#22c55e)"></i>' : '<i class="fa-solid fa-circle" style="color:var(--danger,#ef4444)"></i>'}
                            Step 3: PO Token Provider (bgutil)
                        </h4>
                        <p class="muted" style="margin:0 0 6px;font-size:0.82rem">
                            YouTube requires a Proof of Origin (PO) token to prove requests come from a real client.
                            The <strong>bgutil-ytdlp-pot-provider</strong> plugin generates these automatically.
                        </p>
                        <code style="display:block;background:var(--bg-primary);padding:8px 10px;border-radius:4px;font-size:0.8rem;white-space:pre-wrap"># Install the yt-dlp plugin
pip3 install --break-system-packages bgutil-ytdlp-pot-provider

# Clone and build the server component
cd /home/ubuntu
git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server
npm install && npm run build

# Start the POT server (keep running as a service)
node build/main.js</code>
                        <p class="muted" style="margin:8px 0 0;font-size:0.78rem">
                            The POT server must stay running. Consider setting it up as a systemd service.<br>
                            Node.js must be available in PATH for the script-node provider to work.<br>
                            Verify it works: <code>curl http://localhost:4416/ping</code>
                        </p>
                    </div>

                    <div style="background:var(--bg-tertiary,var(--bg-input));border-radius:6px;padding:14px">
                        <h4 style="margin:0 0 8px;font-size:0.92rem"><i class="fa-solid fa-lightbulb" style="color:var(--warning,#f59e0b)"></i> Troubleshooting</h4>
                        <ul style="margin:0;padding-left:20px;font-size:0.82rem" class="muted">
                            <li><strong>"Sign in to confirm you're not a bot"</strong> — Cookies are expired/invalid. Re-export from a fresh incognito session.</li>
                            <li><strong>"LOGIN_REQUIRED"</strong> — Same as above. Make sure cookies are from a logged-in YouTube session.</li>
                            <li><strong>Extraction works in test but fails in queue</strong> — Stream URLs expire after a few hours. If a request sits in queue too long, re-extraction may be needed.</li>
                            <li><strong>No title / "YouTube video [ID]"</strong> — Metadata extraction failed (cookies issue). The request was added but will fail playback.</li>
                            <li><strong>Update yt-dlp frequently</strong> — YouTube changes their systems regularly. Run: <code>sudo pip3 install --break-system-packages --pre yt-dlp -U</code></li>
                            <li><strong>Use the Test Extraction tool below</strong> to verify everything works before enabling media requests.</li>
                        </ul>
                    </div>
                </div>
            </details>

            <!-- Cookies card -->
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px">
                <h3 style="margin:0 0 8px;font-size:1rem"><i class="fa-solid fa-cookie"></i> YouTube Cookies</h3>
                <p class="muted" style="font-size:0.82rem;margin:0 0 12px">
                    Paste a Netscape-format cookies.txt exported from a logged-in YouTube session in an incognito window.
                    See the setup guide above for detailed steps.
                </p>
                <textarea id="admin-cookies-input" rows="8" placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;SID&#9;value..."
                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:10px;border-radius:6px;font-family:monospace;font-size:0.82rem;resize:vertical"></textarea>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="saveAdminCookies()">
                        <i class="fa-solid fa-floppy-disk"></i> Save Cookies
                    </button>
                    <button class="btn btn-outline" onclick="deleteAdminCookies()" ${cookiesOk ? '' : 'disabled'}>
                        <i class="fa-solid fa-trash"></i> Remove Cookies
                    </button>
                </div>
            </div>

            <!-- Extra Args card -->
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px">
                <h3 style="margin:0 0 8px;font-size:1rem"><i class="fa-solid fa-terminal"></i> Extra yt-dlp Arguments</h3>
                <p class="muted" style="font-size:0.82rem;margin:0 0 12px">
                    Additional CLI arguments passed to yt-dlp on every call. One argument per line.
                    Lines starting with <code>#</code> are ignored.
                </p>
                <details class="muted" style="font-size:0.8rem;margin-bottom:10px">
                    <summary style="cursor:pointer">Common examples</summary>
                    <div style="padding:8px 0 0 8px;line-height:1.8">
                        <code>--extractor-args</code> + <code>youtube:player_client=mweb;fetch_pot=auto</code> — Use mweb client with auto PO tokens<br>
                        <code>--proxy</code> + <code>socks5://user:pass@host:1080</code> — Route through a proxy<br>
                        <code>--geo-bypass-country</code> + <code>US</code> — Bypass geo-restrictions as a specific country<br>
                        <code>--sleep-interval</code> + <code>2</code> — Wait between requests to avoid rate limiting
                    </div>
                </details>
                <textarea id="admin-extra-args-input" rows="6" placeholder="# Extra yt-dlp arguments (one per line)&#10;--extractor-args&#10;youtube:player_client=mweb;fetch_pot=auto"
                    style="width:100%;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:10px;border-radius:6px;font-family:monospace;font-size:0.82rem;resize:vertical">${esc(status.extra_args || '')}</textarea>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="saveAdminExtraArgs()">
                        <i class="fa-solid fa-floppy-disk"></i> Save Args
                    </button>
                    <button class="btn btn-outline" onclick="clearAdminExtraArgs()" ${status.extra_args_configured ? '' : 'disabled'}>
                        <i class="fa-solid fa-trash"></i> Clear
                    </button>
                </div>
            </div>

            <!-- Test card -->
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px">
                <h3 style="margin:0 0 8px;font-size:1rem"><i class="fa-solid fa-flask-vial"></i> Test Extraction</h3>
                <p class="muted" style="font-size:0.82rem;margin:0 0 12px">
                    Test yt-dlp extraction on a URL to verify cookies, PO token, and extraction all work.
                    A successful test means media requests will work for viewers.
                </p>
                <div style="display:flex;gap:8px">
                    <input type="text" id="admin-media-test-url" placeholder="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                        style="flex:1;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:0.9rem">
                    <button class="btn btn-primary" onclick="testAdminExtraction()">
                        <i class="fa-solid fa-play"></i> Test
                    </button>
                </div>
                <div id="admin-media-test-results" style="margin-top:10px"></div>
            </div>
        </div>
    `;
}

async function saveAdminCookies() {
    const ta = document.getElementById('admin-cookies-input');
    if (!ta) return;
    const cookies = ta.value.trim();
    if (!cookies) { toast('Paste cookies.txt content first', 'warning'); return; }
    try {
        await api('/admin/media-tools/cookies', { method: 'PUT', body: { cookies } });
        toast('Cookies saved', 'success');
        loadAdminMediaTools();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteAdminCookies() {
    if (!confirm('Remove yt-dlp cookies?')) return;
    try {
        await api('/admin/media-tools/cookies', { method: 'DELETE' });
        toast('Cookies removed', 'success');
        loadAdminMediaTools();
    } catch (e) { toast(e.message, 'error'); }
}

async function saveAdminExtraArgs() {
    const ta = document.getElementById('admin-extra-args-input');
    if (!ta) return;
    try {
        await api('/admin/media-tools/extra-args', { method: 'PUT', body: { extra_args: ta.value } });
        toast('Extra args saved', 'success');
        loadAdminMediaTools();
    } catch (e) { toast(e.message, 'error'); }
}

async function clearAdminExtraArgs() {
    if (!confirm('Clear yt-dlp extra arguments?')) return;
    try {
        await api('/admin/media-tools/extra-args', { method: 'DELETE' });
        toast('Extra args cleared', 'success');
        loadAdminMediaTools();
    } catch (e) { toast(e.message, 'error'); }
}

async function testAdminExtraction() {
    const url = document.getElementById('admin-media-test-url')?.value?.trim();
    if (!url) { toast('Enter a URL to test', 'warning'); return; }
    const resultsDiv = document.getElementById('admin-media-test-results');
    resultsDiv.innerHTML = '<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Testing… (this may take up to 60s)</p>';
    try {
        const data = await api('/admin/media-tools/test', { method: 'POST', body: { url } });
        let html = '<div style="display:grid;gap:6px;font-size:0.87rem;margin-top:8px">';
        for (const step of (data.steps || [])) {
            const icon = step.ok
                ? '<i class="fa-solid fa-check-circle" style="color:var(--success,#22c55e)"></i>'
                : '<i class="fa-solid fa-xmark-circle" style="color:var(--danger,#ef4444)"></i>';
            let detail = '';
            if (step.data) detail = ' — ' + esc(JSON.stringify(step.data));
            if (step.error) detail = ' — <span style="color:var(--danger,#ef4444)">' + esc(step.error) + '</span>';
            html += `<div>${icon} <strong>${esc(step.name)}</strong>${detail}</div>`;
        }
        html += '</div>';
        resultsDiv.innerHTML = html;
    } catch (e) {
        resultsDiv.innerHTML = `<p style="color:var(--danger,#ef4444)">${esc(e.message)}</p>`;
    }
}
