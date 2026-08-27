/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Vibes (Virtual Currency UI)
   Bit-style: integer bucks. 100 Vibes = $1.00 streamer cashout.
   ═══════════════════════════════════════════════════════════════ */

// Client mirror of the server volume-discount tiers (server is the source of truth;
// this is just for the live custom-amount price preview). Keep in sync with vibes.js.
const _BUCKS_TIERS = [[25000, 0.0110], [10000, 0.0115], [5000, 0.0120], [2500, 0.0124], [1000, 0.0130], [500, 0.0140], [0, 0.0150]];
function _priceForBucks(b) {
    b = Math.max(0, Math.round(Number(b) || 0));
    const t = _BUCKS_TIERS.find(x => b >= x[0]) || _BUCKS_TIERS[_BUCKS_TIERS.length - 1];
    return Math.round(b * t[1] * 100) / 100;
}

/**
 * Generate Buy Vibes modal HTML.
 */
function openvibeBucksBuyModal() {
    return `
        <h3><i class="fa-solid fa-coins"></i> Buy Vibes</h3>
        <p class="muted" style="margin-bottom:16px">Tip streamers with Vibes — bigger packs cost less per buck. 100 Bucks = $1 to the streamer.</p>

        <div class="form-group">
            <label>Choose a pack</label>
            <div id="buy-packages" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
                <p class="muted" style="grid-column:1/-1;text-align:center;font-size:0.85rem">Loading…</p>
            </div>
        </div>

        <div class="form-group">
            <label>Custom amount (Vibes)</label>
            <input type="number" id="modal-buy-amount" class="form-input" placeholder="e.g. 500" min="100" step="100" oninput="updateBuyPrice()">
        </div>
        <div class="form-group" style="text-align:center;padding:8px;background:var(--bg-primary);border-radius:var(--radius)">
            <span id="modal-buy-price" style="font-size:1.2rem;color:var(--accent);font-weight:700">$0.00</span>
            <span class="muted" id="modal-buy-bucks" style="display:block;font-size:0.8rem"></span>
        </div>

        <div id="buy-providers" style="margin-top:8px">
            <p class="muted" style="font-size:0.85rem;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Loading payment options…</p>
        </div>`;
}

/** Populate the buy modal with packages + the enabled payment providers. */
async function _initBuyBucks() {
    const box = document.getElementById('buy-providers');
    if (!box) return;
    let cfg;
    try { cfg = await api('/payments/config'); } catch { cfg = null; }
    // PowerChat purchases have their own enablement — the buy modal stays usable on
    // every channel even while the card/PayPal rails (payments master switch) are off.
    if (!cfg || (!cfg.enabled && !(cfg.providers && cfg.providers.powerchat))) {
        box.innerHTML = '<p class="muted" style="font-size:0.85rem;text-align:center">Purchases aren’t available right now.</p>';
        const pkgBox = document.getElementById('buy-packages'); if (pkgBox) pkgBox.innerHTML = '';
        return;
    }
    // Package buttons.
    const packages = (cfg.packages && cfg.packages.length) ? cfg.packages : [100, 500, 1000, 2500, 5000, 10000].map(bucks => ({ bucks, usd: _priceForBucks(bucks) }));
    const pkgBox = document.getElementById('buy-packages');
    if (pkgBox) pkgBox.innerHTML = packages.map(p =>
        `<button class="btn btn-outline" onclick="setBuyAmount(${p.bucks})">${p.bucks.toLocaleString()} Vibes<br><small>$${Number(p.usd).toFixed(2)}</small></button>`
    ).join('');

    const min = cfg.minPurchaseBucks || 100;
    const amtInput = document.getElementById('modal-buy-amount');
    if (amtInput) { amtInput.min = min; if (!amtInput.value) amtInput.value = packages[0]?.bucks || min; updateBuyPrice(); }

    const P = cfg.providers || {};
    const btn = (prov, label, icon, color) => P[prov]
        ? `<button class="btn btn-lg" style="width:100%;margin-top:8px;justify-content:center;background:${color};color:#fff;border:none" onclick="doPurchase('${prov}')"><i class="${icon}"></i> Pay with ${label}</button>`
        : '';
    const buttons = [
        btn('stripe', 'Card (Stripe)', 'fa-solid fa-credit-card', '#635bff'),
        btn('paypal', 'PayPal', 'fa-brands fa-paypal', '#003087'),
        btn('ccbill', 'Card (CCBill)', 'fa-solid fa-credit-card', '#2a6'),
        btn('crypto', 'Crypto', 'fa-brands fa-bitcoin', '#f7931a'),
        btn('powerchat', 'PowerChat tip', 'fa-solid fa-bolt', '#8b5cf6'),
    ].filter(Boolean).join('');
    box.innerHTML = buttons || '<p class="muted" style="font-size:0.85rem;text-align:center">No payment methods are enabled.</p>';
}

function setBuyAmount(bucks) {
    const el = document.getElementById('modal-buy-amount');
    if (el) { el.value = bucks; updateBuyPrice(); }
}
function updateBuyPrice() {
    const bucks = Math.round(parseFloat(document.getElementById('modal-buy-amount')?.value) || 0);
    const price = document.getElementById('modal-buy-price');
    const sub = document.getElementById('modal-buy-bucks');
    if (price) price.textContent = `$${_priceForBucks(bucks).toFixed(2)}`;
    if (sub) sub.textContent = bucks > 0 ? `${bucks.toLocaleString()} Vibes` : '';
}

async function doPurchase(provider) {
    if (!currentUser) return showModal('login');
    const bucks = Math.round(parseFloat(document.getElementById('modal-buy-amount').value));
    if (!bucks || bucks < 100) return toast('Enter at least 100 Vibes', 'error');
    try {
        const data = await api('/payments/bucks/checkout', { method: 'POST', body: { provider, bucks } });
        if (data.powerchat && data.url) {
            // PowerChat: the tip page opens in a new tab; Vibes are credited by webhook
            // once the tip confirms, so the site stays open underneath.
            window.open(data.url, '_blank', 'noopener');
            toast(data.note || 'Complete your tip on PowerChat — Vibes are credited automatically once it confirms.', 'success');
            closeModal();
            return;
        }
        if (data.url) { window.location.href = data.url; return; }
        toast('Could not start checkout', 'error');
    } catch (e) { toast(e.message || 'Purchase failed', 'error'); }
}

/* ── Channel subscriptions ─────────────────────────────────── */
function openvibeSubscribeModal(username) {
    return `
        <h3><i class="fa-solid fa-star"></i> Subscribe to ${username ? username : 'this channel'}</h3>
        <p class="muted" id="sub-price-line" style="margin-bottom:16px">Monthly channel subscription.</p>
        <div id="subscribe-options" data-streamer="${username || ''}">
            <p class="muted" style="font-size:0.85rem;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>
        </div>`;
}

async function _initSubscribe() {
    const box = document.getElementById('subscribe-options');
    if (!box) return;
    const username = box.dataset.streamer;
    let cfg, info;
    try { [cfg, info] = await Promise.all([api('/payments/config'), api(`/payments/channel/${encodeURIComponent(username)}`)]); }
    catch { box.innerHTML = '<p class="muted">Subscriptions unavailable.</p>'; return; }
    const priceLine = document.getElementById('sub-price-line');
    if (priceLine) priceLine.textContent = `$${(info.priceUsd || cfg.subPriceUsd || 4.99).toFixed(2)}/month · ${info.subscriberCount || 0} subscriber${info.subscriberCount === 1 ? '' : 's'}`;
    if (info.subscribed) { box.innerHTML = '<p style="text-align:center;color:#53fc18"><i class="fa-solid fa-circle-check"></i> You’re subscribed!</p>'; return; }
    if (!cfg.enabled) { box.innerHTML = '<p class="muted" style="text-align:center">Subscriptions aren’t available right now.</p>'; return; }
    let html = '';
    if (cfg.providers && cfg.providers.stripe) {
        html += `<button class="btn btn-lg btn-primary" style="width:100%;margin-top:8px;justify-content:center" onclick="doSubscribe('${username}','stripe')"><i class="fa-solid fa-credit-card"></i> Subscribe with Card (auto-renews)</button>`;
    }
    html += `<button class="btn btn-lg" style="width:100%;margin-top:8px;justify-content:center;background:var(--accent);color:#111;border:none" onclick="doSubscribe('${username}','bucks')"><i class="fa-solid fa-coins"></i> Subscribe with Vibes</button>`;
    if (cfg.providers && cfg.providers.powerchat) {
        html += `<button class="btn btn-lg" style="width:100%;margin-top:8px;justify-content:center;background:#8b5cf6;color:#fff;border:none" onclick="doSubscribe('${username}','powerchat')"><i class="fa-solid fa-bolt"></i> Subscribe with PowerChat tip</button>`;
    }
    // Non-card methods can't be re-charged by the processor, so renewal draws from the
    // Vibes balance — this toggle covers the Vibes and PowerChat buttons.
    html += `<label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:0.85rem;cursor:pointer">
        <input type="checkbox" id="sub-auto-renew" checked style="width:16px;height:16px;cursor:pointer">
        Auto-renew monthly from my Vibes balance (Vibes/PowerChat)
    </label>`;
    box.innerHTML = html;
}

async function doSubscribe(username, provider) {
    if (!currentUser) return showModal('login');
    const autoRenew = !!document.getElementById('sub-auto-renew')?.checked;
    try {
        const data = await api('/payments/subscribe', { method: 'POST', body: { provider, streamer: username, auto_renew: autoRenew } });
        if (data.powerchat && data.url) {
            window.open(data.url, '_blank', 'noopener');
            toast(data.note || 'Complete your tip on PowerChat — your subscription activates automatically once it confirms.', 'success');
            closeModal();
            return;
        }
        if (data.url) { window.location.href = data.url; return; }
        if (data.ok) { toast('Subscribed! 🎉', 'success'); if (typeof loadBalance === 'function') loadBalance(); closeModal(); }
    } catch (e) { toast(e.message || 'Subscription failed', 'error'); }
}

function showSubscribeModal(username) {
    const content = document.getElementById('modal-content');
    content.innerHTML = openvibeSubscribeModal(username);
    document.getElementById('modal-overlay').classList.add('show');
    _initSubscribe();
}

function openSubscribeForCurrentStream() {
    const d = (typeof currentStreamData !== 'undefined' && currentStreamData) || {};
    const username = d.username || d.user_username || d.streamer_username || d.channel_username || d.owner_username
        // Offline channel page / popout chat — the channel identity lives here instead.
        || (typeof currentChannelUsername !== 'undefined' && currentChannelUsername)
        || (typeof chatChannel !== 'undefined' && chatChannel) || null;
    if (!username) return toast('No channel selected', 'error');
    showSubscribeModal(username);
}

/**
 * Generate Donate modal HTML.
 */
function openvibeBucksDonateModal() {
    return `
        <h3><i class="fa-solid fa-gift"></i> Donate Vibes</h3>
        <p class="muted" style="margin-bottom:16px">Support this streamer!</p>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
            <button class="btn btn-outline" onclick="setDonateAmount(100)">100 Vibes</button>
            <button class="btn btn-outline" onclick="setDonateAmount(250)">250 Vibes</button>
            <button class="btn btn-outline" onclick="setDonateAmount(500)">500 Vibes</button>
            <button class="btn btn-outline" onclick="setDonateAmount(1000)">1,000 Vibes</button>
            <button class="btn btn-outline" onclick="setDonateAmount(2500)">2,500 Vibes</button>
            <button class="btn btn-outline" onclick="setDonateAmount(5000)">5,000 Vibes</button>
        </div>

        <div class="form-group">
            <label>Amount (Vibes)</label>
            <input type="number" id="modal-donate-amount" class="form-input" placeholder="e.g. 500" min="1" step="1">
        </div>
        <div class="form-group">
            <label>Message (optional)</label>
            <input type="text" id="modal-donate-message" class="form-input" placeholder="Say something nice..." maxlength="200">
        </div>

        <div class="form-group" id="donate-goal-wrap" style="display:none">
            <label>Put it toward a goal</label>
            <select id="modal-donate-goal" class="form-input"></select>
            <div class="muted" style="font-size:0.75rem;margin-top:3px">Applies to Vibes donations AND PowerChat tips.</div>
        </div>

        <div class="muted" id="donate-balance-line" style="font-size:0.82rem;margin:2px 0 6px"></div>
        <button class="btn btn-primary btn-lg" onclick="doDonate()" style="width:100%;margin-top:4px">
            <i class="fa-solid fa-coins"></i> Donate Vibes
        </button>
        <button class="btn btn-outline" onclick="showModal('buy-funds')" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-cart-plus"></i> Buy Vibes
        </button>
        <!-- Only shown when THIS streamer has their own PowerChat (money goes to them
             directly, no Vibes involved). Populated by _initDonatePowerchat. -->
        <div id="donate-powerchat-direct" style="display:none">
            <div class="muted" style="text-align:center;font-size:0.75rem;margin:10px 0 4px">— or skip Vibes entirely —</div>
            <button class="btn btn-lg" onclick="doPowerchatTip()" style="width:100%;background:#8b5cf6;color:#fff;border:none">
                <i class="fa-solid fa-bolt"></i> Tip real money via PowerChat
            </button>
        </div>`;
}

// Donate modal boot: balance-first, but NEVER at the cost of the direct route.
//  - Balance ≥ 1: normal Vibes donate form (+ the direct-PowerChat option when the
//    streamer has their own PowerChat).
//  - Balance 0 + streamer HAS PowerChat: stay here and offer BOTH — tip them
//    directly (no Vibes needed) or go buy Vibes first.
//  - Balance 0 + no direct route: straight to Buy Vibes (any channel, all rails).
async function _initDonateModal() {
    const streamerId = _donateStreamerId();
    const [bal, directAvailable] = await Promise.all([
        api('/funds/balance').then(d => Math.round(d.balance || 0)).catch(() => null),
        streamerId
            ? api(`/powerchat/donate-link?streamer_id=${streamerId}`).then(d => !!(d && d.mode === 'direct')).catch(() => false)
            : Promise.resolve(false),
    ]);
    const box = document.getElementById('donate-powerchat-direct');
    if (box && directAvailable) box.style.display = '';
    const line = document.getElementById('donate-balance-line');
    if (bal === null) return; // not logged in / balance unavailable — leave the form as-is
    if (line) line.innerHTML = `Your balance: <strong>${bal.toLocaleString()}</strong> Vibes${bal < 1 ? ' — <a href="#" onclick="showModal(\'buy-funds\');return false">buy some</a> to donate Vibes' : ''}`;
    if (bal < 1 && !directAvailable) {
        toast('You don’t have any Vibes yet — grab some first, then come back to donate! 🛒', 'info');
        showModal('buy-funds');
    } else if (bal < 1 && directAvailable) {
        toast('No Vibes yet — tip this channel directly via PowerChat below, or buy Vibes first. ⚡', 'info');
    }
}

// DIRECT real-money tip — only offered when the streamer has their own PowerChat.
async function doPowerchatTip() {
    const streamerId = _donateStreamerId();
    if (!streamerId) return toast('No streamer selected', 'error');
    try {
        // Carry the donor's goal pick over — it rides in app_purpose and the webhook
        // credits that exact goal when the tip confirms.
        const goalSel = document.getElementById('modal-donate-goal');
        const goalId = goalSel && goalSel.value ? parseInt(goalSel.value, 10) : null;
        const data = await api(`/powerchat/donate-link?streamer_id=${streamerId}${goalId ? `&goal_id=${goalId}` : ''}`);
        if (!data.url) throw new Error('unavailable');
        window.open(data.url, '_blank', 'noopener');
        toast('Complete your tip on PowerChat — it lands in this channel automatically once confirmed. ⚡', 'success');
        closeModal();
    } catch (e) { toast('PowerChat tips aren’t available for this channel.', 'error'); }
}

// The checkout return page broadcasts completion — refresh balances so purchased
// Vibes/subs appear without a manual reload. (Webhook-confirmed server-side; this
// only refreshes the UI.)
try {
    const _pcCheckoutBc = new BroadcastChannel('powerchat-checkout');
    _pcCheckoutBc.onmessage = (e) => {
        if (!e.data || e.data.status !== 'completed') return;
        toast('PowerChat payment received — updating your balance… ⚡', 'success');
        // The webhook usually lands within a couple of seconds of the redirect.
        setTimeout(() => { if (typeof loadBalance === 'function') loadBalance(); }, 2500);
    };
} catch { /* BroadcastChannel unsupported — balance updates on next reload */ }

// Resolve the streamer being viewed (live stream data, else the channel page owner).
function _donateStreamerId() {
    if (typeof currentStreamData !== 'undefined' && currentStreamData && currentStreamData.user_id) return currentStreamData.user_id;
    if (typeof _activeChannelUserId !== 'undefined' && _activeChannelUserId) return _activeChannelUserId;
    return null;
}

// Populate the goal picker when the donate modal opens (called from showModal).
async function _loadDonateGoals() {
    const wrap = document.getElementById('donate-goal-wrap');
    const sel = document.getElementById('modal-donate-goal');
    if (!wrap || !sel) return;
    const streamerId = _donateStreamerId();
    if (!streamerId) { wrap.style.display = 'none'; return; }
    try {
        const data = await api(`/funds/goals/${streamerId}`);
        const goals = (data.goals || []).filter(g => g.is_active);
        if (!goals.length) { wrap.style.display = 'none'; return; }
        sel.innerHTML = `<option value="">General support (no specific goal)</option>` +
            goals.map(g => `<option value="${g.id}">${escHb(g.title)} — ${Number(g.current_amount).toLocaleString()}/${Number(g.target_amount).toLocaleString()} Vibes</option>`).join('');
        wrap.style.display = '';
        // Pre-select a goal if the donate modal was opened from a goal popover.
        if (window._pendingDonateGoalId) {
            const pid = String(window._pendingDonateGoalId);
            if ([...sel.options].some(o => o.value === pid)) sel.value = pid;
            window._pendingDonateGoalId = null;
        }
    } catch { wrap.style.display = 'none'; }
}
function escHb(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function setDonateAmount(amount) {
    document.getElementById('modal-donate-amount').value = amount;
}

async function doDonate() {
    if (!currentUser) return showModal('login');
    const streamerId = _donateStreamerId();
    if (!streamerId) return toast('No streamer selected', 'error');

    const amount = parseFloat(document.getElementById('modal-donate-amount').value);
    const message = document.getElementById('modal-donate-message').value.trim();
    const goalSel = document.getElementById('modal-donate-goal');
    const goalId = goalSel && goalSel.value ? parseInt(goalSel.value, 10) : null;

    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');

    try {
        await api('/funds/donate', {
            method: 'POST',
            body: { streamer_id: streamerId, stream_id: (typeof currentStreamId !== 'undefined' ? currentStreamId : null) || null, amount: Math.round(amount), message, goal_id: goalId }
        });
        toast(`Donated ${Math.round(amount).toLocaleString()} Vibes!`, 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Donation failed', 'error'); }
}

/**
 * Generate Cashout modal HTML.
 */
function openvibeBucksCashoutModal() {
    return `
        <h3><i class="fa-solid fa-money-bill-transfer"></i> Cash Out</h3>
        <p class="muted" style="margin-bottom:16px">Draws from your <strong>cashout balance</strong> (Vibes sent to you). 100 Vibes = $1.00. Minimum 500 Vibes ($5.00). Held in escrow until admin approves.</p>

        <div class="form-group">
            <label>Amount (Vibes)</label>
            <input type="number" id="modal-cashout-amount" class="form-input" placeholder="500" min="500" step="100">
        </div>
        <div class="form-group">
            <label>PayPal Email</label>
            <input type="email" id="modal-cashout-email" class="form-input" placeholder="your@paypal.com">
        </div>
        <div class="form-group" style="text-align:center;padding:8px;background:var(--bg-primary);border-radius:var(--radius)">
            You'll receive: <strong id="modal-cashout-usd">$0.00</strong>
        </div>

        <button class="btn btn-primary btn-lg" onclick="doCashout()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-money-bill-transfer"></i> Request Cashout
        </button>`;
}

document.addEventListener('input', (e) => {
    if (e.target.id === 'modal-cashout-amount') {
        const amt = parseFloat(e.target.value) || 0;
        const usd = document.getElementById('modal-cashout-usd');
        if (usd) usd.textContent = `$${(amt / 100).toFixed(2)}`; // 100 bucks = $1
    }
});

// Show a toast when returning from a hosted checkout, then clean the URL.
document.addEventListener('DOMContentLoaded', () => {
    const q = new URLSearchParams(location.search);
    const purchase = q.get('purchase'), sub = q.get('sub');
    if (!purchase && !sub) return;
    if (purchase === 'success' || sub === 'success') {
        toast(sub === 'success' ? 'Subscription active! 🎉' : 'Purchase complete — your Vibes are on the way!', 'success');
        if (typeof loadBalance === 'function') setTimeout(loadBalance, 1500);
    } else if (purchase === 'cancel' || sub === 'cancel') {
        toast('Checkout canceled.', 'info');
    } else if (purchase === 'error') {
        toast('Payment could not be completed.', 'error');
    }
    q.delete('purchase'); q.delete('sub');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
});

async function doCashout() {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-cashout-amount').value);
    const paypalEmail = document.getElementById('modal-cashout-email').value.trim();

    if (!amount || amount < 500) return toast('Minimum cashout is 500 Vibes ($5.00)', 'error');
    if (!paypalEmail) return toast('PayPal email required', 'error');

    try {
        await api('/funds/cashout', {
            method: 'POST',
            body: { amount: Math.round(amount), paypalEmail }
        });
        toast('Cashout requested! Awaiting admin approval.', 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Cashout failed', 'error'); }
}
