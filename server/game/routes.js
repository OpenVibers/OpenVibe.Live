/**
 * OpenVibeGame — REST API Routes
 * All game endpoints under /api/game/
 */

const express = require('express');
const router = express.Router();
const game = require('./game-engine');
const db = require('../db/database');
const cosmetics = require('../monetization/cosmetics');
const { requireGameAuth } = require('./game-auth');

router.use(requireGameAuth);

// ══════════════════════════════════════════════════════════════
//  PLAYER
// ══════════════════════════════════════════════════════════════

router.get('/player', (req, res) => {
    try {
        const player = game.getPlayer(req.user.id);
        const user = db.getUserById(req.user.id);
        player.openvibe_coins = user?.openvibe_coins_balance || 0;
        res.json({ success: true, player });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  INVENTORY & BANK
// ══════════════════════════════════════════════════════════════

router.get('/inventory', (req, res) => {
    try { res.json({ success: true, items: game.getInventory(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bank', (req, res) => {
    try {
        if (!game.isNearBankNPC(req.user.id)) return res.status(403).json({ error: 'You must visit the Bank NPC in the Outpost!' });
        res.json({ success: true, items: game.getBank(req.user.id) });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bank/deposit', (req, res) => {
    try {
        if (!game.isNearBankNPC(req.user.id)) return res.status(403).json({ error: 'You must visit the Bank NPC in the Outpost!' });
        const { itemId, quantity } = req.body;
        const ok = game.bankDeposit(req.user.id, itemId, quantity || 1);
        if (!ok) return res.json({ error: 'Not enough items' });
        res.json({ success: true, bank: game.getBank(req.user.id), inventory: game.getInventory(req.user.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bank/withdraw', (req, res) => {
    try {
        if (!game.isNearBankNPC(req.user.id)) return res.status(403).json({ error: 'You must visit the Bank NPC in the Outpost!' });
        const { itemId, quantity } = req.body;
        const ok = game.bankWithdraw(req.user.id, itemId, quantity || 1);
        if (!ok) return res.json({ error: 'Not enough in bank' });
        res.json({ success: true, bank: game.getBank(req.user.id), inventory: game.getInventory(req.user.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  NPC INTERACTION
// ══════════════════════════════════════════════════════════════

router.post('/npc/interact', (req, res) => {
    try {
        const { npcId } = req.body;
        if (!npcId) return res.json({ error: 'No NPC specified' });
        if (!game.isNearNPC(req.user.id, npcId)) return res.json({ error: 'Too far from NPC' });
        const user = require('../db/database').getUserById(req.user.id);
        const inv = game.getInventory(req.user.id);
        // Bank NPC returns bank data instead of shop
        if (npcId === 'banker') {
            const bank = game.getBank(req.user.id);
            return res.json({ success: true, npcId, type: 'bank', bank, inventory: inv, openvibe_coins: user?.openvibe_coins_balance || 0 });
        }
        // Tag Master NPC returns tag shop data
        if (npcId === 'tagmaster') {
            const tags = require('./tags');
            const guardianDefeated = tags.hasDefeatedGuardian(req.user.id);
            const shopTags = guardianDefeated ? tags.getShopTags() : [];
            const ownedTags = tags.getUserTags(req.user.id);
            const equipped = tags.getEquippedTag(req.user.id);
            return res.json({
                success: true, npcId, type: 'tag_shop',
                guardianDefeated, tags: shopTags, ownedTags, equipped,
                guardian: !guardianDefeated ? tags.TAG_GUARDIAN : null,
                openvibe_coins: user?.openvibe_coins_balance || 0,
            });
        }
        const items = game.getShopItemsForNPC(npcId);
        const player = game.getPlayer(req.user.id);
        return res.json({ success: true, npcId, type: 'shop', items, inventory: inv, openvibe_coins: user?.openvibe_coins_balance || 0, playerLevels: {
            mining: player.mining_level, fishing: player.fishing_level, woodcut: player.woodcut_level,
            combat: player.combat_level, crafting: player.crafting_level,
        }});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/npc/buy', (req, res) => {
    try {
        const { npcId, itemId, quantity } = req.body;
        if (!game.isNearNPC(req.user.id, npcId)) return res.json({ error: 'Too far from NPC' });
        const result = game.buyItem(req.user.id, itemId, quantity || 1);
        if (result.error) return res.json(result);
        const user = require('../db/database').getUserById(req.user.id);
        // Include inventory refresh and equip state for client update
        const inventory = game.getInventory(req.user.id);
        const player = game.getPlayer(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0, inventory,
            equip_pickaxe: player.equip_pickaxe, equip_axe: player.equip_axe,
            equip_rod: player.equip_rod, equip_weapon: player.equip_weapon,
            equip_armor: player.equip_armor, equip_hat: player.equip_hat,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/npc/sell', (req, res) => {
    try {
        const { npcId, itemId, quantity } = req.body;
        if (!game.isNearNPC(req.user.id, npcId)) return res.json({ error: 'Too far from NPC' });
        const result = game.sellItem(req.user.id, itemId, quantity || 1);
        if (result.error) return res.json(result);
        const user = require('../db/database').getUserById(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  SHOP
// ══════════════════════════════════════════════════════════════

router.get('/shop', (req, res) => {
    try { res.json({ success: true, items: game.getShopItems() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/shop/buy', (req, res) => {
    try {
        const result = game.buyItem(req.user.id, req.body.itemId, req.body.quantity || 1);
        if (result.error) return res.json(result);
        const user = db.getUserById(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/shop/sell', (req, res) => {
    try {
        const result = game.sellItem(req.user.id, req.body.itemId, req.body.quantity || 1);
        if (result.error) return res.json(result);
        const user = db.getUserById(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/coinshop', (req, res) => {
    try { res.json({ success: true, items: game.getCoinShopItems() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coinshop/buy', (req, res) => {
    try {
        const result = game.buyWithCoins(req.user.id, req.body.itemId);
        if (result.error) return res.json(result);
        const user = db.getUserById(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  GATHERING
// ══════════════════════════════════════════════════════════════

router.post('/gather', (req, res) => {
    try {
        const { tileX, tileY } = req.body;
        const result = game.gather(req.user.id, tileX, tileY);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  BUILDING
// ══════════════════════════════════════════════════════════════

router.post('/build', (req, res) => {
    try {
        const { structureType, tileX, tileY } = req.body;
        const result = game.placeStructure(req.user.id, structureType, tileX, tileY);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/destroy', (req, res) => {
    try {
        const { tileX, tileY } = req.body;
        const result = game.destroyStructure(req.user.id, tileX, tileY);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/storage/deposit', (req, res) => {
    try {
        const { structureId, itemId, quantity } = req.body;
        const result = game.storageDeposit(req.user.id, structureId, itemId, quantity || 1);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/storage/withdraw', (req, res) => {
    try {
        const { structureId, itemId, quantity } = req.body;
        const result = game.storageWithdraw(req.user.id, structureId, itemId, quantity || 1);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  FARMING
// ══════════════════════════════════════════════════════════════

router.get('/farm', (req, res) => {
    try { res.json({ success: true, plots: game.getFarmPlots(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/farm/plant', (req, res) => {
    try { res.json(game.plant(req.user.id, req.body.plotIndex, req.body.seedId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/farm/water', (req, res) => {
    try { res.json(game.water(req.user.id, req.body.plotIndex)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/farm/harvest', (req, res) => {
    try { res.json(game.harvest(req.user.id, req.body.plotIndex)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  CRAFTING
// ══════════════════════════════════════════════════════════════

router.get('/recipes', (req, res) => {
    try { res.json({ success: true, recipes: game.getUnlockedRecipes(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/craft', (req, res) => {
    try {
        const result = game.craft(req.user.id, req.body.recipeId);
        if (result.error) return res.json(result);
        const unlock = game.rollRecipeUnlock(req.user.id);
        res.json({ ...result, newRecipe: unlock });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  COMBAT (PvP & PvE)
// ══════════════════════════════════════════════════════════════

router.post('/attack', (req, res) => {
    try { res.json(game.attackPlayer(req.user.id, req.body.targetId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/battlestats', (req, res) => {
    try { res.json({ success: true, stats: game.getBattleStats(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dungeon/enter', (req, res) => {
    try { res.json(game.enterDungeon(req.user.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dungeon/fight', (req, res) => {
    try { res.json(game.fightMonster(req.user.id, req.body.monster)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  EQUIPMENT & COSMETICS
// ══════════════════════════════════════════════════════════════

router.post('/equip', (req, res) => {
    try {
        const itemId = req.body.itemId;
        const item = game.ITEMS?.[itemId];
        // Hats are globally equipped cosmetics — sync to cosmetic system
        if (item?.category === 'hats') {
            // Auto-unlock as cosmetic if not already
            if (!cosmetics.ownsCosmetic(req.user.id, itemId)) {
                cosmetics.unlockCosmetic(req.user.id, itemId);
            }
            const cosResult = cosmetics.equipCosmetic(req.user.id, itemId);
            if (cosResult.error) return res.json(cosResult);
            // Update live player hat from cosmetic
            const existing = game.getLivePlayers()[req.user.id];
            if (existing) {
                game.updateLivePlayer(req.user.id, { ...existing, equip_hat: itemId });
            }
            return res.json({ success: true, equipped: itemId, slot: 'equip_hat', global: true });
        }
        const result = game.equipItem(req.user.id, itemId);
        // Update live player state so other players see the new equipment
        if (result.success) {
            const player = game.getPlayer(req.user.id);
            const existing = game.getLivePlayers()[req.user.id];
            if (existing) {
                const cosmeticProfile = cosmetics.getCosmeticProfile(req.user.id);
                game.updateLivePlayer(req.user.id, {
                    ...existing,
                    equip_weapon: player.equip_weapon,
                    equip_armor: player.equip_armor,
                    equip_hat: cosmeticProfile.hatFX?.itemId || null,
                    equip_pickaxe: player.equip_pickaxe,
                    equip_axe: player.equip_axe,
                    equip_rod: player.equip_rod,
                });
            }
        }
        res.json(result);
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/unequip', (req, res) => {
    try {
        const slot = req.body.slot;
        // Hats are globally equipped cosmetics — unequip from cosmetic system
        if (slot === 'hats') {
            cosmetics.unequipSlot(req.user.id, 'hat');
            // Update live player hat
            const existing = game.getLivePlayers()[req.user.id];
            if (existing) {
                game.updateLivePlayer(req.user.id, { ...existing, equip_hat: null });
            }
            return res.json({ success: true, slot: 'equip_hat', global: true });
        }
        const result = game.unequipItem(req.user.id, slot);
        // Update live player state so other players see the change
        if (result.success) {
            const player = game.getPlayer(req.user.id);
            const existing = game.getLivePlayers()[req.user.id];
            if (existing) {
                const cosmeticProfile = cosmetics.getCosmeticProfile(req.user.id);
                game.updateLivePlayer(req.user.id, {
                    ...existing,
                    equip_weapon: player.equip_weapon,
                    equip_armor: player.equip_armor,
                    equip_hat: cosmeticProfile.hatFX?.itemId || null,
                    equip_pickaxe: player.equip_pickaxe,
                    equip_axe: player.equip_axe,
                    equip_rod: player.equip_rod,
                });
            }
        }
        res.json(result);
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cosmetic/equip', (req, res) => {
    try { res.json(game.equipCosmetic(req.user.id, req.body.itemId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cosmetic/unequip', (req, res) => {
    try { res.json(game.unequipCosmetic(req.user.id, req.body.type)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Activate game item → unlock global cosmetic
router.post('/cosmetic/activate', (req, res) => {
    try {
        const cosmetics = require('../monetization/cosmetics');
        const result = cosmetics.activateFromGame(req.user.id, req.body.itemId);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deactivate global cosmetic → return to game item
router.post('/cosmetic/deactivate', (req, res) => {
    try {
        const cosmetics = require('../monetization/cosmetics');
        const result = cosmetics.deactivateToGame(req.user.id, req.body.itemId);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  FISHING & SONAR
// ══════════════════════════════════════════════════════════════

router.post('/use-sonar', (req, res) => {
    try {
        const { tileX, tileY } = req.body;
        res.json(game.useSonar(req.user.id, tileX, tileY));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fish-collection', (req, res) => {
    try { res.json({ success: true, ...game.getFishCollection(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  EFFECTS & CONSUMABLES
// ══════════════════════════════════════════════════════════════

router.post('/use', (req, res) => {
    try { res.json(game.useConsumable(req.user.id, req.body.itemId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/effects', (req, res) => {
    try { res.json({ success: true, effects: game.getActiveEffects(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  LEADERBOARDS
// ══════════════════════════════════════════════════════════════

router.get('/leaderboard/:type', (req, res) => {
    try { res.json({ success: true, entries: game.getLeaderboard(req.params.type) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ACHIEVEMENTS
// ══════════════════════════════════════════════════════════════

router.get('/achievements', (req, res) => {
    try {
        const data = game.getAchievements(req.user.id);
        res.json({ success: true, ...data });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  DAILY QUESTS
// ══════════════════════════════════════════════════════════════

router.get('/daily-quests', (req, res) => {
    try { res.json({ success: true, ...game.getDailyQuests(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/daily-quests/claim', (req, res) => {
    try { res.json(game.claimDailyQuest(req.user.id, req.body.questId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  TAGS
// ══════════════════════════════════════════════════════════════

const tags = require('./tags');

// Get the user's owned tags + equipped tag
router.get('/tags', (req, res) => {
    try {
        const owned = tags.getUserTags(req.user.id);
        const equipped = tags.getEquippedTag(req.user.id);
        res.json({ success: true, tags: owned, equipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get the tag shop catalog
router.get('/tags/shop', (req, res) => {
    try {
        const shopTags = tags.getShopTags();
        const guardianDefeated = tags.hasDefeatedGuardian(req.user.id);
        const user = db.getUserById(req.user.id);
        res.json({ success: true, tags: shopTags, guardianDefeated, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all tags (for wiki / catalog view)
router.get('/tags/catalog', (req, res) => {
    try { res.json({ success: true, tags: tags.getAllTags() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Fight the Tag Guardian
router.post('/tags/guardian/fight', (req, res) => {
    try {
        if (!game.isNearNPC(req.user.id, 'tagmaster')) return res.json({ error: 'You must be near the Tag Master\'s building!' });
        const result = tags.fightGuardian(req.user.id);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Buy a tag from the Tag Master
router.post('/tags/buy', (req, res) => {
    try {
        if (!game.isNearNPC(req.user.id, 'tagmaster')) return res.json({ error: 'You must visit the Tag Master NPC!' });
        const result = tags.buyTag(req.user.id, req.body.tagId);
        if (result.error) return res.json(result);
        const user = db.getUserById(req.user.id);
        res.json({ ...result, openvibe_coins: user?.openvibe_coins_balance || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Equip a tag
router.post('/tags/equip', (req, res) => {
    try { res.json(tags.equipTag(req.user.id, req.body.tagId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Unequip current tag
router.post('/tags/unequip', (req, res) => {
    try { res.json(tags.unequipTag(req.user.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
