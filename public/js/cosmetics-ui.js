/**
 * OpenVibe.Live — Cosmetics Inventory UI
 * Opens from the OpenCoins badge in the navbar.
 * Allows equipping/unequipping name effects, particles, hats, and voices.
 * Supports activate (game item → global cosmetic) and deactivate (back to game item).
 */

/* ── State ────────────────────────────────────────────────────── */
let cosmeticsData = null;   // { categories: { name_effect: [], particle: [], hat: [], voice: [] }, equipped: {} }
let cosmeticsCatalog = null; // Full catalog from server
let cosmeticsActiveTab = 'name_effect';

/* ── Open / Close ─────────────────────────────────────────────── */
function openCosmeticsModal() {
    if (!currentUser) {
        toast('Log in to view your inventory', 'warning');
        return;
    }
    document.getElementById('cosmetics-modal').classList.add('active');
    loadCosmeticsInventory();
}

function closeCosmeticsModal() {
    document.getElementById('cosmetics-modal').classList.remove('active');
}

// Close on overlay click
document.getElementById('cosmetics-modal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('cosmetics-modal-overlay')) closeCosmeticsModal();
});

/* ── Tab Switching ────────────────────────────────────────────── */
function switchCosmeticTab(cat, btn) {
    cosmeticsActiveTab = cat;
    // Update tab buttons
    document.querySelectorAll('.cosmetics-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    // Show correct category
    document.querySelectorAll('.cosmetics-category').forEach(c => c.classList.remove('active'));
    const target = document.getElementById(`cosmetics-cat-${cat}`);
    if (target) target.classList.add('active');
}

/* ── Load Data ────────────────────────────────────────────────── */
async function loadCosmeticsInventory() {
    try {
        const hdrs = authHeaders();
        const [invRes, catRes] = await Promise.all([
            fetch('/api/cosmetics/inventory', { headers: hdrs }),
            cosmeticsCatalog ? Promise.resolve(null) : fetch('/api/cosmetics/catalog'),
        ]);

        if (!invRes.ok) {
            const err = await invRes.json().catch(() => ({}));
            toast(err.error || 'Failed to load inventory', 'error');
            return;
        }

        cosmeticsData = await invRes.json();

        if (catRes) {
            const catData = await catRes.json();
            cosmeticsCatalog = catData.catalog;
        }

        renderCosmeticsUI();
    } catch (err) {
        console.error('[Cosmetics] Load error:', err);
        toast('Failed to load inventory', 'error');
    }
}

/* ── Render ───────────────────────────────────────────────────── */
function renderCosmeticsUI() {
    if (!cosmeticsData || !cosmeticsCatalog) return;

    const { categories: owned, equipped } = cosmeticsData;
    const ownedMap = {};
    for (const cat of Object.keys(owned)) {
        for (const item of owned[cat]) {
            ownedMap[item.itemId] = item;
        }
    }

    // Render each category from the full catalog
    for (const [cat, items] of Object.entries(cosmeticsCatalog)) {
        const container = document.getElementById(`cosmetics-cat-${cat}`);
        if (!container) continue;

        if (!items.length) {
            container.innerHTML = `<div class="cosmetics-empty"><i class="fa-solid fa-box-open"></i><br>No ${cat.replace('_', ' ')} cosmetics available yet</div>`;
            continue;
        }

        const grid = document.createElement('div');
        grid.className = 'cosmetics-grid';

        for (const item of items) {
            const isOwned = !!ownedMap[item.itemId];
            const isEquipped = equipped[cat === 'name_effect' ? 'name_effect' : cat] === item.itemId;

            const card = document.createElement('div');
            const userIsAdminCard = !!(currentUser?.capabilities?.admin_panel);
            card.className = `cosmetic-card${isEquipped ? ' equipped' : ''}${!isOwned && !userIsAdminCard ? ' locked' : ''}`;

            const userIsAdmin = !!(currentUser?.capabilities?.admin_panel);
            let actionsHtml = '';
            if (isOwned) {
                if (isEquipped) {
                    actionsHtml = `
                        <button class="cosmetic-btn cosmetic-btn-unequip" onclick="cosmeticUnequip('${cat === 'name_effect' ? 'name_effect' : cat}')">Unequip</button>
                        <button class="cosmetic-btn cosmetic-btn-convert" onclick="cosmeticDeactivate('${item.itemId}')" title="Send back to game inventory">Return to Game</button>
                    `;
                } else {
                    actionsHtml = `
                        <button class="cosmetic-btn cosmetic-btn-equip" onclick="cosmeticEquip('${item.itemId}')">Equip</button>
                        <button class="cosmetic-btn cosmetic-btn-convert" onclick="cosmeticDeactivate('${item.itemId}')" title="Send back to game inventory">Return to Game</button>
                    `;
                }
            } else if (userIsAdmin) {
                // Admin bypass: can equip any cosmetic without owning it
                if (isEquipped) {
                    actionsHtml = `
                        <button class="cosmetic-btn cosmetic-btn-unequip" onclick="cosmeticUnequip('${cat === 'name_effect' ? 'name_effect' : cat}')">Unequip</button>
                    `;
                } else {
                    actionsHtml = `
                        <button class="cosmetic-btn cosmetic-btn-equip" onclick="cosmeticEquip('${item.itemId}')">Equip</button>
                        <span class="cosmetic-desc" style="font-style:italic;opacity:0.5;font-size:0.75rem">🔓 Admin bypass</span>
                    `;
                }
            } else {
                actionsHtml = `<span class="cosmetic-desc" style="font-style:italic;opacity:0.7">🎮 Unlock in OpenVibeGame, then activate from your game inventory</span>`;
            }

            const badgeHtml = isEquipped
                ? `<span class="cosmetic-badge equipped-badge">EQUIPPED</span>`
                : `<span class="cosmetic-badge tier-badge">T${item.tier}</span>`;

            // Preview class for name effects
            const previewClass = (cat === 'name_effect' && item.cssClass) ? ` ${item.cssClass}` : '';

            card.innerHTML = `
                <span class="cosmetic-emoji">${item.emoji}</span>
                <div class="cosmetic-name${previewClass}">${esc(item.name)}</div>
                <div class="cosmetic-desc">${esc(item.desc)}</div>
                ${badgeHtml}
                <div class="cosmetic-actions">${actionsHtml}</div>
            `;

            grid.appendChild(card);
        }

        container.innerHTML = '';
        container.appendChild(grid);
    }
}

/* ── API Actions ──────────────────────────────────────────────── */
async function cosmeticEquip(itemId) {
    try {
        const res = await fetch('/api/cosmetics/equip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ itemId }),
        });
        const data = await res.json();
        if (data.error) { toast(data.error, 'error'); return; }
        toast(`Equipped ${data.item?.name || itemId}!`, 'success');
        loadCosmeticsInventory();
    } catch (err) {
        toast('Failed to equip', 'error');
    }
}

async function cosmeticUnequip(slot) {
    try {
        const res = await fetch('/api/cosmetics/unequip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ slot }),
        });
        const data = await res.json();
        if (data.error) { toast(data.error, 'error'); return; }
        toast(`Unequipped ${slot.replace('_', ' ')}`, 'info');
        loadCosmeticsInventory();
    } catch (err) {
        toast('Failed to unequip', 'error');
    }
}

async function cosmeticActivate(itemId) {
    try {
        const res = await fetch('/api/cosmetics/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ itemId }),
        });
        const data = await res.json();
        if (data.error) { toast(data.error, 'error'); return; }
        toast(data.message || 'Unlocked!', 'success');
        loadCosmeticsInventory();
    } catch (err) {
        toast('Failed to activate', 'error');
    }
}

async function cosmeticDeactivate(itemId) {
    if (!confirm('Convert this cosmetic back to a game item? You will lose the global effect.')) return;
    try {
        const res = await fetch('/api/cosmetics/deactivate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ itemId }),
        });
        const data = await res.json();
        if (data.error) { toast(data.error, 'error'); return; }
        toast(data.message || 'Converted back to game item', 'info');
        loadCosmeticsInventory();
    } catch (err) {
        toast('Failed to deactivate', 'error');
    }
}

/* ── Escape to close ──────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('cosmetics-modal')?.classList.contains('active')) {
        closeCosmeticsModal();
    }
});
