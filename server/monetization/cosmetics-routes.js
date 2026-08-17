/**
 * OpenVibe.Live — Cosmetics API Routes
 * 
 * GET    /api/cosmetics/catalog         - All available cosmetics
 * GET    /api/cosmetics/inventory       - User's unlocked cosmetics + equipped
 * GET    /api/cosmetics/equipped/:userId - Public: get equipped cosmetics for a user
 * POST   /api/cosmetics/equip           - Equip a cosmetic
 * POST   /api/cosmetics/unequip         - Unequip a slot
 * POST   /api/cosmetics/activate        - Consume game item → unlock cosmetic
 * POST   /api/cosmetics/deactivate      - Revoke cosmetic → return game item
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const { isAdmin } = require('../auth/permissions');
const cosmetics = require('./cosmetics');

const router = express.Router();

// ── Get Full Catalog ─────────────────────────────────────────
router.get('/catalog', (req, res) => {
    const catalog = {};
    for (const [id, c] of Object.entries(cosmetics.COSMETICS)) {
        if (!catalog[c.category]) catalog[c.category] = [];
        catalog[c.category].push({ itemId: id, ...c });
    }
    // Sort each category by tier
    for (const arr of Object.values(catalog)) arr.sort((a, b) => a.tier - b.tier);
    res.json({ catalog });
});

// ── Get User Inventory + Equipped ────────────────────────────
router.get('/inventory', requireAuth, (req, res) => {
    const data = cosmetics.getFullInventory(req.user.id);
    res.json(data);
});

// ── Get Equipped Cosmetics (public, for chat rendering) ──────
router.get('/equipped/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid userId' });
    const profile = cosmetics.getCosmeticProfile(userId);
    res.json(profile);
});

// ── Equip a Cosmetic ─────────────────────────────────────────
router.post('/equip', requireAuth, (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = cosmetics.equipCosmetic(req.user.id, itemId, { isAdmin: isAdmin(req.user) });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Unequip a Slot ───────────────────────────────────────────
router.post('/unequip', requireAuth, (req, res) => {
    const { slot } = req.body;
    if (!slot) return res.status(400).json({ error: 'slot required (name_effect, particle, hat, voice)' });
    const result = cosmetics.unequipSlot(req.user.id, slot);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Activate: consume game item → unlock cosmetic globally ───
router.post('/activate', requireAuth, async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = await cosmetics.activateFromGame(req.user.id, itemId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Deactivate: revoke cosmetic → add back to game inventory ─
router.post('/deactivate', requireAuth, async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = await cosmetics.deactivateToGame(req.user.id, itemId);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Internal: auto-unlock cosmetic from openvibe-quest game ──────
// Called server-to-server when openvibe-quest game awards a hat/cosmetic item.
router.post('/internal-unlock', (req, res) => {
    if (req.headers['x-internal-secret'] !== 'openvibe-internal-2026') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { userId, itemId } = req.body;
    if (!userId || !itemId) return res.status(400).json({ error: 'userId and itemId required' });
    try {
        const result = cosmetics.unlockCosmetic(userId, itemId);
        res.json(result);
    } catch (err) {
        console.error(`[Cosmetics] internal-unlock error for user ${userId}, item ${itemId}:`, err.message);
        res.status(400).json({ error: 'Failed to unlock — user may not exist on openvibelive' });
    }
});

module.exports = router;
