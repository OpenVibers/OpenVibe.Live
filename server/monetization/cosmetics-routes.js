/**
 * OpenVibe.Live — Cosmetics API Routes
 * 
 * GET    /api/cosmetics/catalog         - All available cosmetics
 * GET    /api/cosmetics/inventory       - User's unlocked cosmetics + equipped
 * GET    /api/cosmetics/equipped/:userId - Public: get equipped cosmetics for a user
 * POST   /api/cosmetics/equip           - Equip a cosmetic
 * POST   /api/cosmetics/unequip         - Unequip a slot
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const { isAdmin } = require('../auth/permissions');
const cosmetics = require('./cosmetics');

const router = express.Router();

// ── Get Full Catalog ─────────────────────────────────────────
router.get('/catalog', async (req, res) => {
    // `earn: 'quest'` marks the items a quest on OpenVibe.Quest gives (Inventory's grantors for them).
    const earn = await cosmetics.earnable();
    const catalog = {};
    for (const [id, c] of Object.entries(cosmetics.COSMETICS)) {
        if (!catalog[c.category]) catalog[c.category] = [];
        catalog[c.category].push({ itemId: id, ...c, ...(earn[id] ? { earn: earn[id] } : {}) });
    }
    // Sort each category by tier
    for (const arr of Object.values(catalog)) arr.sort((a, b) => a.tier - b.tier);
    res.json({ catalog });
});

// ── Get User Inventory + Equipped ────────────────────────────
router.get('/inventory', requireAuth, async (req, res) => {
    const data = await cosmetics.getFullInventory(req.user.id);
    res.json(data);
});

// ── Get Equipped Cosmetics (public, for chat rendering) ──────
router.get('/equipped/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid userId' });
    const profile = await cosmetics.getCosmeticProfile(userId);
    res.json(profile);
});

// ── Equip a Cosmetic ─────────────────────────────────────────
router.post('/equip', requireAuth, async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = await cosmetics.equipCosmetic(req.user.id, itemId, { isAdmin: isAdmin(req.user) });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Unequip a Slot ───────────────────────────────────────────
router.post('/unequip', requireAuth, async (req, res) => {
    const { slot } = req.body;
    if (!slot) return res.status(400).json({ error: 'slot required (name_effect, particle, hat, voice)' });
    const result = await cosmetics.unequipSlot(req.user.id, slot);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// The openvibe-quest game-item bridge is gone (plan T2; the quest game runs nowhere, so these always failed). Open
// tabs of the previous release may still call them for one release (ADR-016 N-1): they answer 410 behind the same
// auth, then the next release deletes both.
for (const p of ['/activate', '/deactivate']) {
    router.post(p, requireAuth, (req, res) => res.status(410).json({ error: 'Game items no longer convert to cosmetics' }));
}

module.exports = router;
