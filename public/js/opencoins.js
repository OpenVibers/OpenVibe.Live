/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — OpenCoins (Loyalty Points UI)
   Free currency earned by watching & chatting.
   Viewers redeem streamer-configured rewards.
   ═══════════════════════════════════════════════════════════════ */

// ── Coin Heartbeat (passive earning while watching) ──────────
let coinHeartbeatInterval = null;

function startCoinHeartbeat(streamId) {
    stopCoinHeartbeat();
    if (!currentUser || !streamId) return;
    startBonusGame(streamId);

    // Send heartbeat every 60 seconds (server tracks 5-min earning intervals)
    coinHeartbeatInterval = setInterval(async () => {
        try {
            const data = await api('/coins/heartbeat', {
                method: 'POST',
                body: { streamId },
            });
            if (data.earned > 0) {
                showCoinToast(data.earned, data.balance);
            }
            // Watching earns this channel's CHANNEL POINTS (not the global OpenCoins
            // navbar), so only update the in-chat / rewards-panel balance.
            document.querySelectorAll('.rewards-coin-balance').forEach(el => {
                el.textContent = (data.balance || 0).toLocaleString();
            });
        } catch { /* silent */ }
    }, 60_000);
}

function stopCoinHeartbeat() {
    if (coinHeartbeatInterval) {
        clearInterval(coinHeartbeatInterval);
        coinHeartbeatInterval = null;
    }
    stopBonusGame();
}

// ── Clickable bonus game (a chest appears on a timer for extra points) ──
let _bonusTimer = null;
async function startBonusGame(streamId) {
    stopBonusGame();
    if (!currentUser || !streamId || typeof currentStreamData === 'undefined' || !currentStreamData) return;
    if (String(currentStreamData.user_id) === String(currentUser.id)) return; // not on your own stream
    let cfg;
    try { cfg = (await api(`/coins/config/${currentStreamData.user_id}`)).config; } catch { return; }
    _applyChannelPointsBranding(cfg);
    const mins = cfg && cfg.game_interval_min;
    if (!mins || mins <= 0) return;
    _bonusTimer = setInterval(() => _showBonusChest(streamId), mins * 60_000);
}
function stopBonusGame() {
    if (_bonusTimer) { clearInterval(_bonusTimer); _bonusTimer = null; }
    document.getElementById('cp-bonus-chest')?.remove();
}
function _showBonusChest(streamId) {
    if (document.getElementById('cp-bonus-chest')) return;
    const el = document.createElement('button');
    el.id = 'cp-bonus-chest';
    el.className = 'cp-bonus-chest';
    el.title = `Claim bonus ${channelPointsName()}!`;
    el.innerHTML = `<i class="fa-solid ${_cpIcon}"></i>`;
    el.onclick = async () => {
        el.disabled = true;
        try {
            const d = await api('/coins/bonus', { method: 'POST', body: { streamId } });
            showCoinToast(d.earned, d.balance);
            document.querySelectorAll('.rewards-coin-balance').forEach(x => { x.textContent = (d.balance || 0).toLocaleString(); });
        } catch (e) { toast(e.message || 'Not available yet', 'error'); }
        el.remove();
    };
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, 30_000); // vanishes if unclaimed
}

// Per-streamer channel-points branding (set from the rewards API response).
let _cpName = 'Channel Points';
let _cpIcon = 'fa-coins';
function channelPointsName() { return _cpName || 'Channel Points'; }

// Apply a streamer's channel-points branding (name + FA icon) to the rewards panel,
// the in-chat points button, and any labelled elements.
function _applyChannelPointsBranding(cfg) {
    if (!cfg) return;
    _cpName = cfg.name || 'Channel Points';
    _cpIcon = cfg.icon || 'fa-coins';
    document.querySelectorAll('.rewards-cp-label').forEach(el => { el.textContent = _cpName; });
    document.querySelectorAll('.rewards-cp-icon, .chat-nickels-float > i').forEach(el => {
        el.className = (el.classList.contains('rewards-cp-icon') ? 'fa-solid rewards-cp-icon ' : 'fa-solid ') + _cpIcon;
    });
    document.querySelectorAll('.chat-nickels-float').forEach(b => { b.title = _cpName + ' — this channel (click for rewards)'; });
}

function showCoinToast(earned, total) {
    toast(`+${earned} ${channelPointsName()} earned!`, 'success');
}

// ── Rewards Panel Toggle ─────────────────────────────────────
function toggleRewardsPanel() {
    // Find all rewards panels and toggle them
    const panels = document.querySelectorAll('.rewards-panel');
    let anyVisible = false;
    panels.forEach(panel => {
        if (panel.style.display !== 'none') anyVisible = true;
    });
    panels.forEach(panel => {
        panel.style.display = anyVisible ? 'none' : '';
    });
    if (!anyVisible) {
        loadRewardsPanel();
    }
}

async function loadRewardsPanel() {
    // Channel points are per-CHANNEL, not per live session — resolve the owner from
    // the live stream OR the channel context (offline channel page / popout chat).
    const ownerId = (typeof currentStreamData !== 'undefined' && currentStreamData && currentStreamData.user_id)
        || (typeof _activeChannelUserId !== 'undefined' && _activeChannelUserId) || null;
    if (!ownerId) {
        document.querySelectorAll('.rewards-grid').forEach(g => {
            g.innerHTML = '<p class="muted" style="padding:8px">Join a channel to see rewards</p>';
        });
        return;
    }
    const grids = document.querySelectorAll('.rewards-grid');
    if (!grids.length) return;

    try {
        const data = await api(`/coins/rewards/${ownerId}`);
        const rewards = data.rewards || [];
        _applyChannelPointsBranding(data.config);

        const html = !rewards.length
            ? '<p class="muted" style="padding:8px">No rewards configured for this channel</p>'
            : rewards.map(r => {
                const safeId = parseInt(r.id) || 0;
                const safeCost = parseInt(r.cost) || 0;
                const safeInput = r.requires_input ? 1 : 0;
                return `
                <button class="reward-btn" data-rid="${safeId}" data-title="${esc(r.title)}" data-cost="${safeCost}" data-input="${safeInput}"
                        onclick="rewardClick(+this.dataset.rid, this.dataset.title, +this.dataset.cost, +this.dataset.input)"
                        style="--reward-color:${esc(r.color || '#8b5cf6')}" title="${esc(r.description || r.title)}">
                    <i class="fa-solid ${esc(r.icon || 'fa-star')}"></i>
                    <span class="reward-title">${esc(r.title)}</span>
                    <span class="reward-cost"><i class="fa-solid ${esc(_cpIcon)}"></i> ${safeCost.toLocaleString()}</span>
                </button>
            `; }).join('');

        grids.forEach(g => { g.innerHTML = html; });
    } catch {
        grids.forEach(g => { g.innerHTML = '<p class="muted" style="padding:8px">Failed to load rewards</p>'; });
    }

    // Update this channel's points balance in all reward panels
    try {
        const coinData = await api(`/coins/channel-balance?streamerId=${ownerId}`);
        document.querySelectorAll('.rewards-coin-balance').forEach(el => {
            el.textContent = (coinData.balance || 0).toLocaleString();
        });
    } catch { /* silent */ }
}

// ── Reward Click Handler ─────────────────────────────────────
function rewardClick(rewardId, title, cost, requiresInput) {
    if (!currentUser) return showModal('login');

    if (requiresInput) {
        // Show input modal
        showRedeemModal(rewardId, title, cost);
        return;
    }

    doRedeem(rewardId);
}

function showRedeemModal(rewardId, title, cost) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = `
        <h3><i class="fa-solid ${esc(_cpIcon)}"></i> ${esc(title)}</h3>
        <p class="muted" style="margin-bottom:12px">Cost: <strong>${cost.toLocaleString()} ${esc(channelPointsName())}</strong></p>
        <div class="form-group">
            <label>Your Message</label>
            <input type="text" id="modal-redeem-input" class="form-input" placeholder="Type your message..." maxlength="200">
        </div>
        <button class="btn btn-primary btn-lg" onclick="doRedeem(${rewardId}, document.getElementById('modal-redeem-input').value)" style="width:100%;margin-top:8px">
            <i class="fa-solid ${esc(_cpIcon)}"></i> Redeem
        </button>`;
    overlay.classList.add('show');
}

async function doRedeem(rewardId, userInput) {
    if (!currentUser) return showModal('login');
    try {
        const body = { rewardId, streamId: currentStreamId };
        if (userInput) body.userInput = userInput;

        const data = await api('/coins/redeem', { method: 'POST', body });
        toast(data.message || 'Redeemed!', 'success');
        closeModal();

        // Redeeming spends CHANNEL POINTS (in-chat balance), not the global OpenCoins navbar.
        document.querySelectorAll('.rewards-coin-balance').forEach(el => {
            if (data.remaining !== undefined) el.textContent = data.remaining.toLocaleString();
        });

        loadRewardsPanel();
    } catch (e) {
        toast(e.message || 'Redemption failed', 'error');
    }
}

// ── Chat coin_earned handler ─────────────────────────────────
// This is called from chat.js when a coin_earned message arrives
function handleCoinEarned(msg) {
    if (msg.total === undefined) return;
    // "gold" events change the GLOBAL OpenCoins wallet → update the navbar.
    if (msg.currency === 'gold') {
        const navCoins = document.getElementById('nav-coins-amount');
        if (navCoins) navCoins.textContent = msg.total.toLocaleString();
        return;
    }
    // Otherwise it's CHANNEL POINTS for a streamer → update the in-chat balance,
    // but only for the channel currently being watched.
    if (msg.streamerId && typeof _navPointsStreamerId !== 'undefined' && _navPointsStreamerId
        && String(msg.streamerId) !== String(_navPointsStreamerId)) return;
    document.querySelectorAll('.rewards-coin-balance').forEach(el => {
        el.textContent = msg.total.toLocaleString();
    });
}

// ── Chat redemption handler ──────────────────────────────────
function renderRedemption(msg, container) {
    const el = document.createElement('div');
    el.className = 'chat-msg redemption';
    el.innerHTML = `<i class="fa-solid fa-gem" style="color:${esc(msg.reward_color || 'var(--accent)')}"></i> <strong>${esc(msg.username || 'Someone')}</strong> redeemed <strong>${esc(msg.reward_title || 'a reward')}</strong>${msg.user_input ? `: ${esc(msg.user_input)}` : ''} <span class="muted">(${(msg.cost || 0).toLocaleString()} ${esc(channelPointsName())})</span>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

// ── Add Reward Modal (Dashboard) ─────────────────────────────
function addRewardModal() {
    return `
        <h3><i class="fa-solid fa-gift"></i> Add OpenCoins Reward</h3>
        <p class="muted" style="margin-bottom:12px">Create a reward viewers can redeem with OpenCoins</p>
        <div class="form-group">
            <label>Reward Title</label>
            <input type="text" id="modal-reward-title" class="form-input" placeholder="e.g. Play Theme Song">
        </div>
        <div class="form-group">
            <label>Description (optional)</label>
            <input type="text" id="modal-reward-desc" class="form-input" placeholder="What happens when redeemed?">
        </div>
        <div class="form-group">
            <label>Cost (OpenCoins)</label>
            <input type="number" id="modal-reward-cost" class="form-input" placeholder="100" min="1" value="100">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
                <label>Icon (Font Awesome)</label>
                <select id="modal-reward-icon" class="form-input">
                    <option value="fa-star">⭐ Star</option>
                    <option value="fa-music">🎵 Music</option>
                    <option value="fa-microphone">🎤 Mic</option>
                    <option value="fa-fire">🔥 Fire</option>
                    <option value="fa-bolt">⚡ Bolt</option>
                    <option value="fa-heart">❤️ Heart</option>
                    <option value="fa-trophy">🏆 Trophy</option>
                    <option value="fa-gamepad">🎮 Game</option>
                    <option value="fa-circle-nodes">🕸️ Network</option>
                    <option value="fa-skull">💀 Skull</option>
                </select>
            </div>
            <div class="form-group">
                <label>Color</label>
                <input type="color" id="modal-reward-color" value="#8b5cf6" style="width:100%;height:36px;border:none;cursor:pointer">
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
                <label>Cooldown (seconds)</label>
                <input type="number" id="modal-reward-cooldown" class="form-input" value="0" min="0">
            </div>
            <div class="form-group">
                <label>Max per stream (0=∞)</label>
                <input type="number" id="modal-reward-max" class="form-input" value="0" min="0">
            </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
            <input type="checkbox" id="modal-reward-input"> Require viewer message
        </label>
        <button class="btn btn-primary btn-lg" onclick="doAddReward()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-plus"></i> Create Reward
        </button>`;
}

async function doAddReward() {
    const title = document.getElementById('modal-reward-title').value.trim();
    const description = document.getElementById('modal-reward-desc').value.trim();
    const cost = parseInt(document.getElementById('modal-reward-cost').value) || 100;
    const icon = document.getElementById('modal-reward-icon').value;
    const color = document.getElementById('modal-reward-color').value;
    const cooldown_seconds = parseInt(document.getElementById('modal-reward-cooldown').value) || 0;
    const max_per_stream = parseInt(document.getElementById('modal-reward-max').value) || 0;
    const requires_input = document.getElementById('modal-reward-input').checked;

    if (!title) return toast('Title required', 'error');
    if (cost < 1) return toast('Cost must be at least 1', 'error');

    try {
        await api('/coins/rewards', {
            method: 'POST',
            body: { title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input },
        });
        toast('Reward created!', 'success');
        closeModal();
        if (typeof loadDashRewards === 'function') loadDashRewards();
    } catch (e) { toast(e.message || 'Failed to create reward', 'error'); }
}

// ── Dashboard Channel Points config (migrated from the channel popover) ──
async function loadDashPointsConfig() {
    if (!currentUser) return;
    const nameEl = document.getElementById('dash-cp-name');
    if (!nameEl) return;
    try {
        const data = await api(`/coins/config/${currentUser.id}`);
        const cp = data.config || {};
        nameEl.value = cp.name || 'Channel Points';
        const set = (id, v) => { const el = document.getElementById(id); if (el != null) el.value = v; };
        set('dash-cp-icon', cp.icon || 'fa-coins');
        set('dash-cp-interval', cp.watch_interval_min ?? 5);
        set('dash-cp-amount', cp.watch_amount ?? 10);
        set('dash-cp-game', cp.game_interval_min ?? 0);
    } catch { /* silent */ }
}

async function saveDashPointsConfig(btn) {
    const g = (id) => document.getElementById(id);
    const payload = {
        name: g('dash-cp-name')?.value || 'Channel Points',
        icon: (g('dash-cp-icon')?.value || 'fa-coins').trim(),
        watch_interval_min: parseInt(g('dash-cp-interval')?.value) || 5,
        watch_amount: parseInt(g('dash-cp-amount')?.value) || 0,
        game_interval_min: parseInt(g('dash-cp-game')?.value) || 0,
    };
    if (btn) btn.disabled = true;
    try {
        await api('/coins/config', { method: 'PUT', body: payload });
        toast('Channel Points saved', 'success');
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
    finally { if (btn) btn.disabled = false; }
}

// ── Dashboard Rewards Management ─────────────────────────────
async function loadDashRewards() {
    if (!currentUser) return;
    const list = document.getElementById('dash-rewards-list');
    if (!list) return;

    try {
        const data = await api(`/coins/rewards/${currentUser.id}`);
        const rewards = data.rewards || [];

        if (!rewards.length) {
            list.innerHTML = '<p class="muted">No rewards yet. Create one to get started!</p>';
            return;
        }

        list.innerHTML = rewards.map(r => `
            <div class="dash-reward-card" style="--reward-color:${esc(r.color || '#8b5cf6')}">
                <div class="dash-reward-icon"><i class="fa-solid ${esc(r.icon || 'fa-star')}"></i></div>
                <div class="dash-reward-info">
                    <strong>${esc(r.title)}</strong>
                    <span class="muted">${r.cost.toLocaleString()} coins${r.description ? ' — ' + esc(r.description) : ''}</span>
                    <span class="muted" style="font-size:0.75rem">Redeemed ${r.redemption_count || 0}x${r.cooldown_seconds ? ' | ' + r.cooldown_seconds + 's cooldown' : ''}${r.max_per_stream ? ' | max ' + r.max_per_stream + '/stream' : ''}</span>
                </div>
                <div class="dash-reward-actions">
                    <button class="btn btn-small btn-outline" onclick="toggleRewardEnabled(${r.id}, ${r.is_enabled ? 0 : 1})">
                        ${r.is_enabled ? '<i class="fa-solid fa-eye-slash"></i> Disable' : '<i class="fa-solid fa-eye"></i> Enable'}
                    </button>
                    <button class="btn btn-small btn-danger" onclick="deleteDashReward(${r.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    } catch {
        list.innerHTML = '<p class="muted">Failed to load rewards</p>';
    }
}

async function toggleRewardEnabled(rewardId, enabled) {
    try {
        await api(`/coins/rewards/${rewardId}`, { method: 'PUT', body: { is_enabled: enabled } });
        toast(enabled ? 'Reward enabled' : 'Reward disabled', 'success');
        loadDashRewards();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteDashReward(rewardId) {
    if (!confirm('Delete this reward?')) return;
    try {
        await api(`/coins/rewards/${rewardId}`, { method: 'DELETE' });
        toast('Reward deleted', 'success');
        loadDashRewards();
    } catch (e) { toast(e.message, 'error'); }
}

// ── Dashboard Redemption Queue ───────────────────────────────
async function loadDashRedemptions() {
    if (!currentUser) return;
    const list = document.getElementById('dash-redemptions-list');
    if (!list) return;

    try {
        const data = await api('/coins/redemptions');
        const items = data.redemptions || [];

        if (!items.length) {
            list.innerHTML = '<p class="muted">No pending redemptions</p>';
            return;
        }

        list.innerHTML = items.map(r => `
            <div class="redemption-item">
                <div class="redemption-info">
                    <i class="fa-solid ${esc(r.icon || 'fa-star')}" style="color:${esc(r.color || 'var(--accent)')}"></i>
                    <strong>${esc(r.display_name || r.username)}</strong> redeemed
                    <strong>${esc(r.reward_title)}</strong>
                    <span class="muted">(${r.cost} coins)</span>
                    ${r.user_input ? `<br><span class="muted">"${esc(r.user_input)}"</span>` : ''}
                </div>
                <div class="redemption-actions">
                    <button class="btn btn-small btn-success" onclick="resolveRedemption(${r.id}, 'fulfilled')">
                        <i class="fa-solid fa-check"></i> Fulfill
                    </button>
                    <button class="btn btn-small btn-danger" onclick="resolveRedemption(${r.id}, 'rejected')">
                        <i class="fa-solid fa-xmark"></i> Reject
                    </button>
                </div>
            </div>
        `).join('');
    } catch {
        list.innerHTML = '<p class="muted">Failed to load redemptions</p>';
    }
}

async function resolveRedemption(id, status) {
    try {
        await api(`/coins/redemptions/${id}`, { method: 'POST', body: { status } });
        toast(`Redemption ${status}`, 'success');
        loadDashRedemptions();
    } catch (e) { toast(e.message, 'error'); }
}
