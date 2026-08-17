/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Vibes (Virtual Currency UI)
   1 OpenVibe Buck = $1.00 USD
   ═══════════════════════════════════════════════════════════════ */

/**
 * Generate Buy Vibes modal HTML.
 */
function openvibeBucksBuyModal() {
    return `
        <h3><i class="fa-solid fa-coins"></i> Buy Vibes</h3>
        <p class="muted" style="margin-bottom:16px">1 OpenVibe Buck = $1.00</p>

        <div class="form-group">
            <label>Amount</label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
                <button class="btn btn-outline" onclick="setBuyAmount(5)">5 HB<br><small>$5</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(10)">10 HB<br><small>$10</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(25)">25 HB<br><small>$25</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(50)">50 HB<br><small>$50</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(100)">100 HB<br><small>$100</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(250)">250 HB<br><small>$250</small></button>
            </div>
        </div>

        <div class="form-group">
            <label>Custom Amount</label>
            <input type="number" id="modal-buy-amount" class="form-input" placeholder="Enter amount" min="1">
        </div>
        <div class="form-group" style="text-align:center;padding:8px;background:var(--bg-primary);border-radius:var(--radius)">
            <span id="modal-buy-price" style="font-size:1.2rem;color:var(--accent);font-weight:700">$0.00</span>
        </div>

        <button class="btn btn-primary btn-lg" onclick="doPurchase()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-credit-card"></i> Purchase via PayPal
        </button>
        <p class="muted" style="margin-top:8px;font-size:0.8rem;text-align:center">
            PayPal integration is simulated in this demo.
        </p>`;
}

function setBuyAmount(amount) {
    document.getElementById('modal-buy-amount').value = amount;
    updateBuyPrice();
}

function updateBuyPrice() {
    const amount = parseFloat(document.getElementById('modal-buy-amount')?.value) || 0;
    const price = document.getElementById('modal-buy-price');
    if (price) price.textContent = `$${amount.toFixed(2)}`;
}

// Attach price update to input
document.addEventListener('input', (e) => {
    if (e.target.id === 'modal-buy-amount') updateBuyPrice();
});

async function doPurchase() {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-buy-amount').value);
    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');

    try {
        // Simulated purchase — in production this would go through PayPal first
        const data = await api('/funds/purchase', {
            method: 'POST',
            body: { amount, paypalTransactionId: `demo_${Date.now()}` }
        });
        toast(`Purchased ${amount} Vibes!`, 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Purchase failed', 'error'); }
}

/**
 * Generate Donate modal HTML.
 */
function openvibeBucksDonateModal() {
    return `
        <h3><i class="fa-solid fa-gift"></i> Donate Vibes</h3>
        <p class="muted" style="margin-bottom:16px">Support this streamer!</p>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
            <button class="btn btn-outline" onclick="setDonateAmount(1)">1 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(2)">2 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(5)">5 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(10)">10 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(25)">25 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(50)">50 HB</button>
        </div>

        <div class="form-group">
            <label>Amount</label>
            <input type="number" id="modal-donate-amount" class="form-input" placeholder="Amount" min="1">
        </div>
        <div class="form-group">
            <label>Message (optional)</label>
            <input type="text" id="modal-donate-message" class="form-input" placeholder="Say something nice..." maxlength="200">
        </div>

        <button class="btn btn-primary btn-lg" onclick="doDonate()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-coins"></i> Donate
        </button>`;
}

function setDonateAmount(amount) {
    document.getElementById('modal-donate-amount').value = amount;
}

async function doDonate() {
    if (!currentUser) return showModal('login');
    if (!currentStreamId) return toast('No stream selected', 'error');

    const amount = parseFloat(document.getElementById('modal-donate-amount').value);
    const message = document.getElementById('modal-donate-message').value.trim();

    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');

    try {
        await api('/funds/donate', {
            method: 'POST',
            body: { streamId: currentStreamId, amount, message }
        });
        toast(`Donated ${amount} Vibes!`, 'success');
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
        <p class="muted" style="margin-bottom:16px">Minimum $5.00. Funds are held in escrow until admin approves.</p>

        <div class="form-group">
            <label>Amount (Vibes)</label>
            <input type="number" id="modal-cashout-amount" class="form-input" placeholder="5" min="5">
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
        if (usd) usd.textContent = `$${amt.toFixed(2)}`;
    }
});

async function doCashout() {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-cashout-amount').value);
    const paypalEmail = document.getElementById('modal-cashout-email').value.trim();

    if (!amount || amount < 5) return toast('Minimum cashout is $5.00', 'error');
    if (!paypalEmail) return toast('PayPal email required', 'error');

    try {
        await api('/funds/cashout', {
            method: 'POST',
            body: { amount, paypalEmail }
        });
        toast('Cashout requested! Awaiting admin approval.', 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Cashout failed', 'error'); }
}
