let dashModerationChannels = [];

function ensureDashModerationCard() {
    // Lives in the Moderation tab panel's grid.
    const grid = document.getElementById('dash-grid-moderation') || document.querySelector('#page-dashboard .dash-grid');
    if (!grid) return null;

    let card = document.getElementById('dash-moderation-card');
    if (!card) {
        card = document.createElement('div');
        card.id = 'dash-moderation-card';
        card.className = 'dash-card dash-card-wide';
        card.innerHTML = `
            <h3><i class="fa-solid fa-shield-halved"></i> Channel Moderation</h3>
            <p class="muted">Owner and channel-mod tools for managing chat, moderators, and logs.</p>
            <div id="dash-moderation-body"><p class="muted">Loading moderation tools...</p></div>
        `;
        grid.appendChild(card);
    } else if (card.parentElement !== grid) {
        grid.appendChild(card);
    }

    return document.getElementById('dash-moderation-body');
}

function dashModerationTitle(channel) {
    return channel.title || channel.display_name || channel.username || `Channel #${channel.id}`;
}

function dashModerationRole(channel) {
    if (channel.user_id === currentUser?.id) return 'Owner';
    return 'Moderator';
}

function dashFormatModerationDate(value) {
    if (!value) return '-';
    const normalized = value.includes('T') || value.endsWith('Z')
        ? value
        : value.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function dashSummarizeModerationAction(action) {
    const details = action.details || {};
    const parts = [];
    if (details.reason) parts.push(details.reason);
    if (details.username) parts.push(`user ${details.username}`);
    if (details.stream_id) parts.push(`stream #${details.stream_id}`);
    if (details.count) parts.push(`${details.count} items`);
    return parts.join(' - ') || 'No details';
}

function renderDashModerationChannels(channels) {
    const body = ensureDashModerationCard();
    if (!body) return;

    if (!channels.length) {
        body.innerHTML = '<p class="muted">You do not have channel moderation assignments yet.</p>';
        return;
    }

    body.innerHTML = channels.map((channel) => {
        const settings = channel.moderation_settings || {};
        const moderators = channel.moderators || [];
        const disabledCats = (() => { try { return JSON.parse(settings.slur_filter_disabled_categories || '[]') || []; } catch { return []; } })();
        return `
            <section class="dash-mod-channel">
                <div class="dash-mod-header">
                    <div>
                        <h4>${esc(dashModerationTitle(channel))}</h4>
                        <p class="muted">${esc(dashModerationRole(channel))} access for channel #${channel.id}</p>
                    </div>
                </div>

                <div class="dash-mod-grid">
                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-user-shield"></i> Moderators</h5>
                        <div class="staff-toolbar">
                            <input type="text" id="dash-mod-add-${channel.id}" class="form-input" placeholder="Username to add">
                            <button class="btn btn-outline" onclick="dashAddChannelModerator(${channel.id})"><i class="fa-solid fa-plus"></i> Add</button>
                        </div>
                        <div class="dash-mod-list">
                            ${moderators.length ? moderators.map((moderator) => `
                                <div class="dash-mod-list-row">
                                    <div>
                                        <strong>${esc(moderator.display_name || moderator.username)}</strong>
                                        <div class="muted">@${esc(moderator.username)}</div>
                                    </div>
                                    <button class="btn btn-small" onclick="dashRemoveChannelModerator(${channel.id}, ${moderator.id}, '${esc(moderator.username)}')">
                                        <i class="fa-solid fa-user-minus"></i> Remove
                                    </button>
                                </div>
                            `).join('') : '<p class="muted">No channel moderators yet.</p>'}
                        </div>
                    </div>

                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-sliders"></i> Chat Settings</h5>
                        <div class="dash-mod-settings">
                            <label><span>Slowmode Seconds</span><input type="number" id="dash-mod-slow-${channel.id}" class="form-input" value="${Number(settings.slowmode_seconds || 0)}"></label>
                            <label><span>Max Message Length</span><input type="number" min="1" max="${(currentUser?.role === 'admin') ? 6000 : 4000}" id="dash-mod-maxlen-${channel.id}" class="form-input" value="${Number(settings.max_message_length || 500)}"></label>
                            <label><span>Max TTS Length</span><input type="number" min="10" max="1200" id="dash-mod-ttslen-${channel.id}" class="form-input" value="${Number(settings.tts_max_length || 200)}"></label>
                            <label><span>Account Age Gate (hours)</span><input type="number" id="dash-mod-age-${channel.id}" class="form-input" value="${Number(settings.account_age_gate_hours || 0)}"></label>
                            <label><span>Caps Limit (%)</span><input type="number" id="dash-mod-caps-${channel.id}" class="form-input" value="${Number(settings.caps_percentage_limit || 70)}"></label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-anon-${channel.id}" ${Number(settings.allow_anonymous ?? 1) ? 'checked' : ''}> Allow Anonymous</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-links-${channel.id}" ${Number(settings.links_allowed ?? 1) ? 'checked' : ''}> Allow Links</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-gifs-${channel.id}" ${Number(settings.gifs_enabled ?? 1) ? 'checked' : ''}> Allow GIFs (Tenor / Giphy)</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-filter-${channel.id}" ${Number(settings.aggressive_filter || 0) ? 'checked' : ''}> Aggressive Filter</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-enabled-${channel.id}" ${Number(settings.slur_filter_enabled || 0) ? 'checked' : ''}> Streamer Anti-Slur Nudge (optional, includes core slur protection)</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-builtin-${channel.id}" ${Number(settings.slur_filter_use_builtin ?? 1) ? 'checked' : ''}> Use built-in hate/slur regex pack</label>
                            <div style="margin-left:1.2rem;display:flex;flex-direction:column;gap:0.15rem">
                                <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-cat-n_word-${channel.id}" ${!disabledCats.includes('n_word') ? 'checked' : ''}> Block N-word</label>
                                <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-cat-antisemitic-${channel.id}" ${!disabledCats.includes('antisemitic') ? 'checked' : ''}> Block antisemitic slurs</label>
                                <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-cat-homophobic-${channel.id}" ${!disabledCats.includes('homophobic') ? 'checked' : ''}> Block homophobic slurs</label>
                                <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-slur-cat-racial-${channel.id}" ${!disabledCats.includes('racial') ? 'checked' : ''}> Block racial slurs (spic, chink)</label>
                            </div>
                            <label>
                                <span>Blocked Terms (comma or newline separated, added to core list)</span>
                                <textarea id="dash-mod-slur-terms-${channel.id}" class="form-input" rows="3" placeholder="Put words/phrases you want blocked in this channel chat only">${esc(String(settings.slur_filter_terms || ''))}</textarea>
                            </label>
                            <label>
                                <span>Custom Regex Rules (one per line, applied to normalized text)</span>
                                <textarea id="dash-mod-slur-regex-${channel.id}" class="form-input" rows="4" placeholder="Example: \\bk+[*_ ]*y+[*_ ]*k+[*_ ]*e+\\b">${esc(String(settings.slur_filter_regexes || ''))}</textarea>
                            </label>
                            <label>
                                <span>Nudge Message (optional custom response)</span>
                                <textarea id="dash-mod-slur-msg-${channel.id}" class="form-input" rows="2" placeholder="Friendly/funny message shown when blocked">${esc(String(settings.slur_filter_nudge_message || ''))}</textarea>
                            </label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-followers-${channel.id}" ${Number(settings.followers_only || 0) ? 'checked' : ''}> Followers Only</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-soundboard-${channel.id}" ${Number(settings.soundboard_enabled ?? 1) ? 'checked' : ''}> Allow 101soundboards</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-soundboard-pitch-${channel.id}" ${Number(settings.soundboard_allow_pitch ?? 1) ? 'checked' : ''}> Allow soundboard pitch changes</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-soundboard-speed-${channel.id}" ${Number(settings.soundboard_allow_speed ?? 1) ? 'checked' : ''}> Allow soundboard speed changes</label>
                            <label>
                                <span>Banned 101soundboards IDs (comma or newline separated)</span>
                                <textarea id="dash-mod-soundboard-banned-${channel.id}" class="form-input" rows="2" placeholder="42695124, 35460558">${esc(String(settings.soundboard_banned_ids || ''))}</textarea>
                            </label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-custom-emotes-${channel.id}" ${Number(settings.custom_emotes_enabled ?? 1) ? 'checked' : ''}> <span>Allow viewers to upload channel emotes (gif/png) <i class="fa-solid fa-face-grin-stars" title="Viewers can add custom :emotes: to your channel"></i></span></label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-custom-sounds-${channel.id}" ${Number(settings.custom_sounds_enabled ?? 1) ? 'checked' : ''}> <span>Allow viewers to upload channel sound commands (!name) <i class="fa-solid fa-volume-high" title="Viewers can add !sound clips to your channel"></i></span></label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-uploads-modsonly-${channel.id}" ${Number(settings.uploads_mods_only || 0) ? 'checked' : ''}> Restrict emote/sound uploads to channel mods only</label>
                            <label>
                                <span>Max sound length (seconds)</span>
                                <input type="number" id="dash-mod-max-sound-${channel.id}" class="form-input" min="1" max="30" value="${Number(settings.max_sound_seconds || 10)}" style="max-width:110px;">
                            </label>
                            <div style="display:flex;gap:10px;flex-wrap:wrap">
                                <label style="flex:1;min-width:130px">
                                    <span>Min speed <i class="fa-solid fa-gauge-simple-low" title="e.g. !sound 0.5"></i></span>
                                    <input type="number" id="dash-mod-sound-minspeed-${channel.id}" class="form-input" min="0.1" max="1" step="0.05" value="${Number(settings.sound_min_speed ?? 0.5)}" style="max-width:110px">
                                </label>
                                <label style="flex:1;min-width:130px">
                                    <span>Max speed <i class="fa-solid fa-gauge-simple-high" title="e.g. !sound 3"></i></span>
                                    <input type="number" id="dash-mod-sound-maxspeed-${channel.id}" class="form-input" min="1" max="5" step="0.1" value="${Number(settings.sound_max_speed ?? 3.0)}" style="max-width:110px">
                                </label>
                            </div>
                            <div style="display:flex;gap:10px;flex-wrap:wrap">
                                <label style="flex:1;min-width:130px">
                                    <span>Min pitch (cents) <i class="fa-solid fa-arrow-down" title="e.g. !sound -500p; -1200 = one octave down"></i></span>
                                    <input type="number" id="dash-mod-sound-minpitch-${channel.id}" class="form-input" min="-2400" max="0" step="100" value="${Number(settings.sound_min_pitch_cents ?? -1200)}" style="max-width:110px">
                                </label>
                                <label style="flex:1;min-width:130px">
                                    <span>Max pitch (cents) <i class="fa-solid fa-arrow-up" title="e.g. !sound 500p; 1200 = one octave up"></i></span>
                                    <input type="number" id="dash-mod-sound-maxpitch-${channel.id}" class="form-input" min="0" max="2400" step="100" value="${Number(settings.sound_max_pitch_cents ?? 1200)}" style="max-width:110px">
                                </label>
                            </div>
                            <label>
                                <span>Emote size in chat: <b id="dash-mod-emote-scale-val-${channel.id}">${Number(settings.emote_scale || 100)}</b>%</span>
                                <input type="range" id="dash-mod-emote-scale-${channel.id}" min="50" max="300" step="10" value="${Number(settings.emote_scale || 100)}"
                                    oninput="document.getElementById('dash-mod-emote-scale-val-${channel.id}').textContent = this.value" style="width:100%;">
                                <span class="cu-hint" style="opacity:.6;font-size:12px;">Controls how big gif/png emotes appear for everyone in your chat (100% = default).</span>
                            </label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-viewer-autodel-${channel.id}" ${Number(settings.viewer_auto_delete_enabled ?? 1) ? 'checked' : ''}> Allow viewers to auto-delete their own messages</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-viewer-deleteall-${channel.id}" ${Number(settings.viewer_delete_all_enabled ?? 1) ? 'checked' : ''}> Allow viewers to delete all their own messages</label>
                            <label class="staff-inline-toggle"><input type="checkbox" id="dash-mod-ipapproval-${channel.id}" ${Number(settings.ip_approval_mode || 0) ? 'checked' : ''}> <span>IP Approval Mode <i class="fa-solid fa-shield-halved" title="New IPs must be approved before messages are visible"></i></span></label>
                        </div>
                        <button class="btn btn-primary" onclick="dashSaveChannelModerationSettings(${channel.id})"><i class="fa-solid fa-floppy-disk"></i> Save Settings</button>
                    </div>
                </div>

                ${settings.ip_approval_mode ? `
                <div class="dash-mod-grid">
                    <div class="dash-mod-section dash-mod-section-wide">
                        <h5><i class="fa-solid fa-shield-halved"></i> IP Approval Queue</h5>
                        <div id="dash-mod-ip-queue-${channel.id}" class="dash-mod-ip-queue"><p class="muted">Loading pending messages...</p></div>
                    </div>
                </div>
                ` : ''}

                <div class="dash-mod-grid">
                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-clipboard-list"></i> Recent Actions</h5>
                        <div id="dash-mod-logs-${channel.id}" class="dash-mod-log-list"><p class="muted">Loading moderation log...</p></div>
                    </div>

                    <div class="dash-mod-section">
                        <h5><i class="fa-solid fa-comments"></i> Search Channel Chat</h5>
                        <div class="staff-toolbar">
                            <input type="text" id="dash-mod-search-${channel.id}" class="form-input" placeholder="Search messages..." onkeydown="if(event.key==='Enter')dashSearchChannelChat(${channel.id})">
                            <input type="text" id="dash-mod-search-user-${channel.id}" class="form-input staff-toolbar-small" placeholder="User ID" onkeydown="if(event.key==='Enter')dashSearchChannelChat(${channel.id})">
                            <button class="btn btn-outline" onclick="dashSearchChannelChat(${channel.id})"><i class="fa-solid fa-search"></i> Search</button>
                        </div>
                        <div id="dash-mod-search-results-${channel.id}" class="dash-mod-search-results"><p class="muted">Search this channel's chat history.</p></div>
                    </div>
                </div>
            </section>
        `;
    }).join('');

    channels.forEach((channel) => {
        dashLoadChannelModerationLogs(channel.id);
        const settings = channel.moderation_settings || {};
        if (settings.ip_approval_mode) {
            dashLoadIpApprovalQueue(channel.id);
        }
    });
}

async function loadDashModeration() {
    const body = ensureDashModerationCard();
    if (!body) return;

    if (!currentUser || !hasCapability('can_manage_channels')) {
        body.innerHTML = '<p class="muted">Channel moderation tools appear here for owners and channel mods.</p>';
        return;
    }

    body.innerHTML = '<p class="muted">Loading moderation tools...</p>';

    try {
        const data = await api('/channels/moderation/mine');
        dashModerationChannels = data.channels || [];
        renderDashModerationChannels(dashModerationChannels);
    } catch (err) {
        body.innerHTML = `<p class="muted">Failed to load channel moderation tools: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

async function dashReloadModeration() {
    await loadDashModeration();
}

async function dashLoadChannelModerationLogs(channelId) {
    const target = document.getElementById(`dash-mod-logs-${channelId}`);
    if (!target) return;

    try {
        const data = await api(`/channels/${channelId}/moderation/logs?limit=12`);
        const actions = data.actions || [];
        target.innerHTML = actions.length ? actions.map((action) => `
            <div class="dash-mod-log-entry">
                <strong>${esc(action.action_type || 'action')}</strong>
                <span class="muted">${dashFormatModerationDate(action.created_at)}</span>
                <div class="muted">${esc(dashSummarizeModerationAction(action))}</div>
            </div>
        `).join('') : '<p class="muted">No channel moderation actions yet.</p>';
    } catch (err) {
        target.innerHTML = '<p class="muted">Failed to load channel log.</p>';
    }
}

window.dashAddChannelModerator = async function dashAddChannelModerator(channelId) {
    const input = document.getElementById(`dash-mod-add-${channelId}`);
    const username = input?.value?.trim();
    if (!username) return toast('Enter a username to add.', 'error');

    try {
        await api(`/channels/${channelId}/mods`, {
            method: 'POST',
            body: { username },
        });
        toast(`${username} added as a channel moderator`, 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to add moderator', 'error');
    }
};

window.dashRemoveChannelModerator = async function dashRemoveChannelModerator(channelId, userId, username) {
    if (!confirm(`Remove ${username} as a channel moderator?`)) return;

    try {
        await api(`/channels/${channelId}/mods/${userId}`, { method: 'DELETE' });
        toast(`${username} removed`, 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to remove moderator', 'error');
    }
};

window.dashSaveChannelModerationSettings = async function dashSaveChannelModerationSettings(channelId) {
    try {
        await api(`/channels/${channelId}/moderation`, {
            method: 'PUT',
            body: {
                slowmode_seconds: Number(document.getElementById(`dash-mod-slow-${channelId}`)?.value || 0),
                max_message_length: Number(document.getElementById(`dash-mod-maxlen-${channelId}`)?.value || 500),
                tts_max_length: Number(document.getElementById(`dash-mod-ttslen-${channelId}`)?.value || 200),
                account_age_gate_hours: Number(document.getElementById(`dash-mod-age-${channelId}`)?.value || 0),
                caps_percentage_limit: Number(document.getElementById(`dash-mod-caps-${channelId}`)?.value || 70),
                allow_anonymous: !!document.getElementById(`dash-mod-anon-${channelId}`)?.checked,
                links_allowed: !!document.getElementById(`dash-mod-links-${channelId}`)?.checked,
                gifs_enabled: !!document.getElementById(`dash-mod-gifs-${channelId}`)?.checked,
                aggressive_filter: !!document.getElementById(`dash-mod-filter-${channelId}`)?.checked,
                slur_filter_enabled: !!document.getElementById(`dash-mod-slur-enabled-${channelId}`)?.checked,
                slur_filter_use_builtin: !!document.getElementById(`dash-mod-slur-builtin-${channelId}`)?.checked,
                slur_filter_disabled_categories: (
                    ['n_word', 'antisemitic', 'homophobic', 'racial'].filter(
                        (k) => !document.getElementById(`dash-mod-slur-cat-${k}-${channelId}`)?.checked
                    )
                ),
                slur_filter_terms: String(document.getElementById(`dash-mod-slur-terms-${channelId}`)?.value || ''),
                slur_filter_regexes: String(document.getElementById(`dash-mod-slur-regex-${channelId}`)?.value || ''),
                slur_filter_nudge_message: String(document.getElementById(`dash-mod-slur-msg-${channelId}`)?.value || ''),
                followers_only: !!document.getElementById(`dash-mod-followers-${channelId}`)?.checked,
                soundboard_enabled: !!document.getElementById(`dash-mod-soundboard-${channelId}`)?.checked,
                soundboard_allow_pitch: !!document.getElementById(`dash-mod-soundboard-pitch-${channelId}`)?.checked,
                soundboard_allow_speed: !!document.getElementById(`dash-mod-soundboard-speed-${channelId}`)?.checked,
                soundboard_banned_ids: String(document.getElementById(`dash-mod-soundboard-banned-${channelId}`)?.value || ''),
                viewer_auto_delete_enabled: !!document.getElementById(`dash-mod-viewer-autodel-${channelId}`)?.checked,
                viewer_delete_all_enabled: !!document.getElementById(`dash-mod-viewer-deleteall-${channelId}`)?.checked,
                ip_approval_mode: !!document.getElementById(`dash-mod-ipapproval-${channelId}`)?.checked,
                custom_emotes_enabled: !!document.getElementById(`dash-mod-custom-emotes-${channelId}`)?.checked,
                custom_sounds_enabled: !!document.getElementById(`dash-mod-custom-sounds-${channelId}`)?.checked,
                uploads_mods_only: !!document.getElementById(`dash-mod-uploads-modsonly-${channelId}`)?.checked,
                max_sound_seconds: Number(document.getElementById(`dash-mod-max-sound-${channelId}`)?.value || 10),
                emote_scale: Number(document.getElementById(`dash-mod-emote-scale-${channelId}`)?.value || 100),
                sound_min_speed: Number(document.getElementById(`dash-mod-sound-minspeed-${channelId}`)?.value || 0.5),
                sound_max_speed: Number(document.getElementById(`dash-mod-sound-maxspeed-${channelId}`)?.value || 3.0),
                sound_min_pitch_cents: Number(document.getElementById(`dash-mod-sound-minpitch-${channelId}`)?.value ?? -1200),
                sound_max_pitch_cents: Number(document.getElementById(`dash-mod-sound-maxpitch-${channelId}`)?.value ?? 1200),
            },
        });
        toast('Channel moderation settings saved', 'success');
        await dashReloadModeration();
    } catch (err) {
        toast(err.message || 'Failed to save moderation settings', 'error');
    }
};

window.dashSearchChannelChat = async function dashSearchChannelChat(channelId) {
    const resultTarget = document.getElementById(`dash-mod-search-results-${channelId}`);
    if (!resultTarget) return;

    resultTarget.innerHTML = '<p class="muted">Searching channel chat...</p>';

    try {
        const params = new URLSearchParams({ limit: '20' });
        const query = document.getElementById(`dash-mod-search-${channelId}`)?.value?.trim();
        const userId = document.getElementById(`dash-mod-search-user-${channelId}`)?.value?.trim();
        if (query) params.set('q', query);
        if (userId) params.set('user_id', userId);

        const data = await api(`/channels/${channelId}/moderation/chat-search?${params}`);
        const messages = data.messages || [];

        resultTarget.innerHTML = messages.length ? messages.map((message) => `
            <div class="dash-mod-log-entry">
                <strong>${esc(message.display_name || message.username || 'Anonymous')}</strong>
                <span class="muted">${dashFormatModerationDate(message.timestamp)}</span>
                <div>${esc(message.message || '')}</div>
                <button class="btn btn-small" onclick="dashDeleteChannelMessage(${channelId}, ${message.id || message.message_id})">
                    <i class="fa-solid fa-trash"></i> Delete Message
                </button>
            </div>
        `).join('') : '<p class="muted">No channel messages matched.</p>';
    } catch (err) {
        resultTarget.innerHTML = `<p class="muted">Search failed: ${esc(err.message || 'Unknown error')}</p>`;
    }
};

window.dashDeleteChannelMessage = async function dashDeleteChannelMessage(channelId, messageId) {
    if (!confirm('Delete this chat message?')) return;

    try {
        await api(`/channels/${channelId}/moderation/messages/${messageId}/delete`, { method: 'POST' });
        toast('Message deleted', 'success');
        await dashLoadChannelModerationLogs(channelId);
        await window.dashSearchChannelChat(channelId);
    } catch (err) {
        toast(err.message || 'Failed to delete message', 'error');
    }
};

/* ── IP Approval Queue ────────────────────────────────────── */

async function dashLoadIpApprovalQueue(channelId) {
    const target = document.getElementById(`dash-mod-ip-queue-${channelId}`);
    if (!target) return;

    try {
        const data = await api(`/mod/ip-approval/${channelId}/pending`);
        const pending = data.pending || [];

        if (!pending.length) {
            target.innerHTML = '<p class="muted">No pending IP approvals.</p>';
            return;
        }

        // Group by IP address for easier review
        const byIp = {};
        for (const msg of pending) {
            const ip = msg.ip_address || 'unknown';
            if (!byIp[ip]) byIp[ip] = { ip, geo: msg.geo, messages: [] };
            byIp[ip].messages.push(msg);
        }

        target.innerHTML = Object.values(byIp).map(group => {
            const geoStr = group.geo ? [group.geo.city, group.geo.region, group.geo.country].filter(Boolean).join(', ') : 'Unknown';
            return `
                <div class="dash-ip-approval-group">
                    <div class="dash-ip-approval-header">
                        <div>
                            <strong>${esc(group.ip)}</strong>
                            <span class="muted"> — ${esc(geoStr)}</span>
                            <span class="muted"> (${group.messages.length} message${group.messages.length > 1 ? 's' : ''})</span>
                        </div>
                        <div class="dash-ip-approval-actions">
                            <button class="btn btn-small btn-primary" onclick="dashApproveIp(${channelId}, '${esc(group.ip)}')"><i class="fa-solid fa-check"></i> Approve</button>
                            <button class="btn btn-small" onclick="dashDenyIp(${channelId}, '${esc(group.ip)}')"><i class="fa-solid fa-xmark"></i> Deny</button>
                        </div>
                    </div>
                    <div class="dash-ip-approval-messages">
                        ${group.messages.map(m => `
                            <div class="dash-mod-log-entry">
                                <strong>${esc(m.username || 'Anonymous')}</strong>
                                <span class="muted">${dashFormatModerationDate(m.created_at)}</span>
                                <div>${esc(m.message || '')}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        target.innerHTML = `<p class="muted">Failed to load IP approval queue: ${esc(err.message || 'Unknown error')}</p>`;
    }
}

window.dashApproveIp = async function dashApproveIp(channelId, ip) {
    try {
        const result = await api(`/mod/ip-approval/${channelId}/approve`, {
            method: 'POST',
            body: { ip },
        });
        toast(result.message || 'IP approved', 'success');
        await dashLoadIpApprovalQueue(channelId);
    } catch (err) {
        toast(err.message || 'Failed to approve IP', 'error');
    }
};

window.dashDenyIp = async function dashDenyIp(channelId, ip) {
    if (!confirm(`Deny all messages from IP ${ip}?`)) return;
    try {
        await api(`/mod/ip-approval/${channelId}/deny`, {
            method: 'POST',
            body: { ip },
        });
        toast('IP denied', 'success');
        await dashLoadIpApprovalQueue(channelId);
    } catch (err) {
        toast(err.message || 'Failed to deny IP', 'error');
    }
};

// Moderation loads lazily when its dashboard tab is first opened (registered on the
// tab-loader registry set up in dashboard.js), so it no longer runs on every dashboard load.
window._dashTabLoaders = window._dashTabLoaders || {};
window._dashTabLoaders.moderation = function () { try { loadDashModeration(); } catch (e) { console.warn('[dash] moderation', e); } };
