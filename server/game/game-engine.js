/**
 * OpenVibeGame — Server Game Engine
 * Open-world survival: gathering, building, PvP, crafting, economy
 */

const db = require('../db/database');
const fs = require('fs');
const path = require('path');
const cosmeticsSystem = require('../monetization/cosmetics');
const {
    ITEMS, RECIPES, STRUCTURES, CROPS, MONSTERS, RARITY_COLORS, BIOME_COLORS,
    FISH_TABLES, MINE_TABLES, WOOD_TABLES, WATER_ZONE_TABLES,
    FISH_SPECIES, FISH_JUNK, ROD_TIERS, buildFishTable,
    PICK_TIERS, AXE_TIERS, ORE_NODE_TYPES, getOreNodeType,
    MOB_TYPES,
    WEAPON_STATS, ARMOR_STATS, EQUIP_SKILL_MAP, FOOD_EFFECTS,
    MAP_W, MAP_H, TILE, OUTPOST_X, OUTPOST_Y, OUTPOST_RADIUS,
    NPCS, NPC_LIST, NPC_INTERACT_RANGE,
    xpToLevel, levelToXp, rollLoot,
    hashNoise, getBiomeAt, getResourceNodeAt, getDifficultyTier, isInSafeZone, getWaterZone,
} = require('./items');

let worldSeed = 0;

// ── Dodge i-frame tracking ───────────────────────────────────
const dodgeIframes = new Map(); // userId → expiresAt timestamp

// ── Combo tracking ───────────────────────────────────────────
const comboTrackers = new Map(); // userId → { count, lastHitTime }
const COMBO_WINDOW = 2500; // ms between hits to keep combo
const COMBO_MULTIPLIERS = [1.0, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0]; // index = combo count

// ── Sprint stamina tracking ──────────────────────────────────
const sprintTimers = new Map(); // userId → lastDrainTime

// ── Agility tracking ────────────────────────────────────────
const sprintingPlayers = new Set();       // userIds currently sprinting
const playerDistAccum = new Map();        // userId → accumulated distance for agility XP
const swimmingPlayers = new Set();        // userIds currently in water

// ── Food buff tracking (in-memory for ATK/DEF mods) ─────────
const foodBuffs = new Map(); // userId → { atk, def, sprint_free, xp_mult, max_stamina, hp_regen, expiresAt }

// ══════════════════════════════════════════════════════════════
//  ACHIEVEMENT DEFINITIONS
// ══════════════════════════════════════════════════════════════

const ACHIEVEMENTS = {
    // ── Combat ──
    first_blood:      { name: 'First Blood',        emoji: '🗡️', desc: 'Kill your first mob.',               category: 'combat',     reward: { coins: 25 } },
    mob_slayer_10:    { name: 'Mob Slayer',          emoji: '💀', desc: 'Kill 10 mobs.',                      category: 'combat',     reward: { coins: 100 } },
    mob_slayer_50:    { name: 'Monster Hunter',      emoji: '🏹', desc: 'Kill 50 mobs.',                     category: 'combat',     reward: { coins: 300, item: 'dungeon_key', qty: 3 } },
    mob_slayer_100:   { name: 'Legendary Slayer',    emoji: '⚔️', desc: 'Kill 100 mobs.',                    category: 'combat',     reward: { coins: 750, item: 'hat_wizard', qty: 1 } },
    dragon_slayer:    { name: 'Dragon Slayer',       emoji: '🐉', desc: 'Kill a Dragon Whelp.',               category: 'combat',     reward: { coins: 500, item: 'dungeon_key', qty: 5 } },
    pvp_first:        { name: 'Duelist',             emoji: '🤺', desc: 'Win your first PvP kill.',           category: 'combat',     reward: { coins: 200 } },
    kill_streak_5:    { name: 'Unstoppable',         emoji: '🔥', desc: 'Reach a 5 kill streak.',             category: 'combat',     reward: { coins: 500 } },
    combo_master:     { name: 'Combo Master',        emoji: '💥', desc: 'Land a 5+ combo hit.',               category: 'combat',     reward: { coins: 200 } },
    // ── Gathering ──
    first_gather:     { name: 'Gatherer',            emoji: '🪓', desc: 'Gather your first resource.',        category: 'gathering',  reward: { coins: 10 } },
    gather_100:       { name: 'Resourceful',         emoji: '⛏️', desc: 'Gather 100 resources.',              category: 'gathering',  reward: { coins: 150 } },
    gather_500:       { name: 'Strip Miner',         emoji: '💎', desc: 'Gather 500 resources.',              category: 'gathering',  reward: { coins: 400, item: 'pick_iron', qty: 1 } },
    dragonite_found:  { name: 'Draconic Discovery',  emoji: '🐲', desc: 'Mine Dragonite ore.',                category: 'gathering',  reward: { coins: 300 } },
    crystal_wood:     { name: 'Crystal Lumberjack',  emoji: '✨', desc: 'Chop Crystal Wood.',                 category: 'gathering',  reward: { coins: 250 } },
    // ── Fishing ──
    first_catch:      { name: 'Gone Fishin\'',       emoji: '🎣', desc: 'Catch your first fish.',             category: 'fishing',    reward: { coins: 15 } },
    fish_species_10:  { name: 'Fish Hobbyist',       emoji: '🐠', desc: 'Catch 10 different species.',        category: 'fishing',    reward: { coins: 200 } },
    fish_species_20:  { name: 'Fish Collector',      emoji: '🐡', desc: 'Catch 20 different species.',        category: 'fishing',    reward: { coins: 500 } },
    fish_species_all: { name: 'Master Angler',       emoji: '🏆', desc: 'Catch every fish species.',          category: 'fishing',    reward: { coins: 2000, item: 'hat_crown', qty: 1 } },
    legendary_catch:  { name: 'Legendary Catch',     emoji: '🌟', desc: 'Catch a Legendary fish.',            category: 'fishing',    reward: { coins: 500 } },
    // ── Crafting ──
    first_craft:      { name: 'Artisan',             emoji: '🔨', desc: 'Craft your first item.',             category: 'crafting',   reward: { coins: 15 } },
    craft_25:         { name: 'Craftsman',            emoji: '🧰', desc: 'Craft 25 items.',                   category: 'crafting',   reward: { coins: 200 } },
    craft_100:        { name: 'Master Crafter',       emoji: '⚒️', desc: 'Craft 100 items.',                  category: 'crafting',   reward: { coins: 500 } },
    smelt_first:      { name: 'Forge Lit',            emoji: '🔥', desc: 'Smelt your first bar.',             category: 'crafting',   reward: { coins: 25 } },
    // ── Exploration ──
    explorer_1k:      { name: 'Wanderer',            emoji: '🧭', desc: 'Travel 1000 tiles.',                 category: 'exploration',reward: { coins: 100 } },
    explorer_10k:     { name: 'Pathfinder',          emoji: '🗺️', desc: 'Travel 10,000 tiles.',              category: 'exploration',reward: { coins: 400 } },
    chest_open_1:     { name: 'Treasure Hunter',     emoji: '📦', desc: 'Open your first treasure chest.',    category: 'exploration',reward: { coins: 50 } },
    chest_open_25:    { name: 'Loot Goblin',         emoji: '🧳', desc: 'Open 25 treasure chests.',           category: 'exploration',reward: { coins: 300 } },
    dungeon_enter:    { name: 'Delver',              emoji: '🗝️', desc: 'Enter a dungeon.',                  category: 'exploration',reward: { coins: 100 } },
    dungeon_wins_10:  { name: 'Dungeon Master',      emoji: '🏰', desc: 'Win 10 dungeon fights.',            category: 'exploration',reward: { coins: 500, item: 'hat_crown', qty: 1 } },
    // ── Economy / Milestones ──
    first_hat:        { name: 'Dapper',              emoji: '🎩', desc: 'Equip your first hat.',              category: 'milestones', reward: { coins: 50 } },
    level_10_any:     { name: 'Apprentice',          emoji: '📈', desc: 'Reach level 10 in any skill.',       category: 'milestones', reward: { coins: 200 } },
    level_25_any:     { name: 'Journeyman',          emoji: '📊', desc: 'Reach level 25 in any skill.',       category: 'milestones', reward: { coins: 500 } },
    level_50_any:     { name: 'Expert',              emoji: '🏅', desc: 'Reach level 50 in any skill.',       category: 'milestones', reward: { coins: 1500 } },
    total_level_50:   { name: 'Well Rounded',        emoji: '🌟', desc: 'Reach total level 50.',              category: 'milestones', reward: { coins: 300 } },
    total_level_100:  { name: 'OpenVibe Legend',          emoji: '👑', desc: 'Reach total level 100.',             category: 'milestones', reward: { coins: 1000, item: 'hat_halo', qty: 1 } },
    die_10:           { name: 'Punching Bag',        emoji: '😵', desc: 'Die 10 times.',                     category: 'milestones', reward: { coins: 50 } },
    build_10:         { name: 'Home Builder',        emoji: '🏠', desc: 'Build 10 structures.',               category: 'milestones', reward: { coins: 150 } },
};

// Pending achievement notifications to send to players
const pendingAchievements = new Map(); // userId → [{ achievementId, ...ACHIEVEMENTS[id] }]

// ══════════════════════════════════════════════════════════════
//  DAILY QUESTS
// ══════════════════════════════════════════════════════════════

const DAILY_QUEST_SLOTS = 3;
const DAILY_QUESTS = [
    { id: 'forage_run',      pool: 'easy',   stat: 'gather_count',     target: 12,  emoji: '🪓', name: 'Forage Run',      desc: 'Gather 12 resources anywhere in the wild.', reward: { coins: 90, item: 'bait_worm', qty: 5 } },
    { id: 'pond_hopper',     pool: 'easy',   stat: 'fish_count',       target: 3,   emoji: '🎣', name: 'Pond Hopper',     desc: 'Catch 3 fish today.',                        reward: { coins: 85, item: 'potion_stamina', qty: 1 } },
    { id: 'road_trip',       pool: 'easy',   stat: 'tiles_traveled',   target: 180, emoji: '🧭', name: 'Road Trip',       desc: 'Travel 180 tiles across the world.',         reward: { coins: 95, item: 'potion_health', qty: 1 } },
    { id: 'bench_worker',    pool: 'medium', stat: 'craft_count',      target: 3,   emoji: '🔨', name: 'Bench Worker',    desc: 'Craft 3 items.',                            reward: { coins: 135, item: 'potion_stamina', qty: 2 } },
    { id: 'camp_clearout',   pool: 'medium', stat: 'mob_kills',        target: 5,   emoji: '⚔️', name: 'Camp Clearout',   desc: 'Defeat 5 mobs.',                            reward: { coins: 145, item: 'potion_health', qty: 2 } },
    { id: 'lockbox_luck',    pool: 'medium', stat: 'chests_opened',    target: 1,   emoji: '📦', name: 'Lockbox Luck',    desc: 'Open 1 treasure chest.',                    reward: { coins: 140, item: 'dungeon_key', qty: 1 } },
    { id: 'builder_brigade', pool: 'hard',   stat: 'structures_built', target: 2,   emoji: '🏗️', name: 'Builder Brigade', desc: 'Build 2 structures.',                       reward: { coins: 190, item: 'bar_iron', qty: 2 } },
    { id: 'long_haul',       pool: 'hard',   stat: 'tiles_traveled',   target: 450, emoji: '🗺️', name: 'Long Haul',       desc: 'Travel 450 tiles in one day.',              reward: { coins: 210, item: 'food_fish_stew', qty: 1 } },
    { id: 'harvest_hustle',  pool: 'hard',   stat: 'gather_count',     target: 30,  emoji: '⛏️', name: 'Harvest Hustle',  desc: 'Gather 30 resources today.',                reward: { coins: 220, item: 'potion_stamina', qty: 3 } },
];

function getDailyQuestDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getDailyQuestResetAt() {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
}

function hashString(input) {
    let hash = 2166136261;
    const str = String(input || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function createSeededRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function getDailyQuestTemplates(userId, questDate = getDailyQuestDate()) {
    const rng = createSeededRng(hashString(`${userId}:${questDate}:daily-quests`));
    const pools = ['easy', 'medium', 'hard'];
    const selected = [];
    for (const pool of pools) {
        const options = DAILY_QUESTS.filter(q => q.pool === pool);
        if (!options.length) continue;
        selected.push(options[Math.floor(rng() * options.length)]);
    }
    return selected;
}

function incrementDailyQuestStat(userId, statKey, amount = 1) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || !statKey) return;
    const questDate = getDailyQuestDate();
    db.run(`INSERT INTO game_daily_quest_progress (user_id, quest_date, stat_key, value, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, quest_date, stat_key)
        DO UPDATE SET value = value + excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [userId, questDate, statKey, value]);
}

function getDailyQuestProgressMap(userId, questDate = getDailyQuestDate()) {
    const rows = db.all('SELECT stat_key, value FROM game_daily_quest_progress WHERE user_id = ? AND quest_date = ?', [userId, questDate]);
    return rows.reduce((acc, row) => {
        acc[row.stat_key] = Number(row.value) || 0;
        return acc;
    }, {});
}

function getDailyQuestClaimedSet(userId, questDate = getDailyQuestDate()) {
    const rows = db.all('SELECT quest_id FROM game_daily_quest_claims WHERE user_id = ? AND quest_date = ?', [userId, questDate]);
    return new Set(rows.map(row => row.quest_id));
}

function getDailyQuestStreak(userId, questDate = getDailyQuestDate()) {
    const rows = db.all(`SELECT quest_date, COUNT(*) as claimed
        FROM game_daily_quest_claims
        WHERE user_id = ?
        GROUP BY quest_date
        HAVING claimed >= ?
        ORDER BY quest_date DESC`, [userId, DAILY_QUEST_SLOTS]);
    const completedDays = new Set(rows.map(row => row.quest_date));
    let streak = 0;
    const cursor = new Date(`${questDate}T00:00:00.000Z`);
    while (completedDays.has(cursor.toISOString().slice(0, 10))) {
        streak++;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
}

function getDailyQuests(userId, questDate = getDailyQuestDate()) {
    const templates = getDailyQuestTemplates(userId, questDate);
    const progressMap = getDailyQuestProgressMap(userId, questDate);
    const claimedSet = getDailyQuestClaimedSet(userId, questDate);
    const quests = templates.map(template => {
        const progressRaw = progressMap[template.stat] || 0;
        const progress = Math.min(template.target, Math.floor(progressRaw));
        return {
            ...template,
            progress,
            completed: progressRaw >= template.target,
            claimed: claimedSet.has(template.id),
        };
    });
    return {
        date: questDate,
        nextResetAt: getDailyQuestResetAt(),
        streak: getDailyQuestStreak(userId, questDate),
        claimed: quests.filter(q => q.claimed).length,
        completed: quests.filter(q => q.completed).length,
        total: quests.length,
        quests,
    };
}

function claimDailyQuest(userId, questId) {
    const questDate = getDailyQuestDate();
    const daily = getDailyQuests(userId, questDate);
    const quest = daily.quests.find(entry => entry.id === questId);
    if (!quest) return { error: 'Quest not found.' };
    if (quest.claimed) return { error: 'Quest already claimed.' };
    if (!quest.completed) return { error: 'Quest is not complete yet.' };

    db.run('INSERT OR IGNORE INTO game_daily_quest_claims (user_id, quest_date, quest_id) VALUES (?, ?, ?)', [userId, questDate, questId]);
    if (quest.reward?.coins) db.addOpenCoins(userId, quest.reward.coins);
    if (quest.reward?.item) addItem(userId, quest.reward.item, quest.reward.qty || 1);

    return {
        success: true,
        quest: { ...quest, claimed: true },
        reward: quest.reward,
        daily: getDailyQuests(userId, questDate),
    };
}

// ══════════════════════════════════════════════════════════════
//  WEATHER SYSTEM
// ══════════════════════════════════════════════════════════════

const WEATHER_TYPES = ['clear', 'rain', 'storm', 'fog', 'snow'];
const WEATHER_DURATIONS = { clear: [5,15], rain: [3,10], storm: [2,6], fog: [3,8], snow: [4,10] }; // min minutes
let currentWeather = 'clear';
let weatherChangesAt = 0;

function tickWeather() {
    if (Date.now() < weatherChangesAt) return false;
    // Pick new weather (weighted — clear most common)
    const weights = { clear: 40, rain: 25, fog: 15, storm: 10, snow: 10 };
    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    let roll = Math.random() * total;
    for (const [w, weight] of Object.entries(weights)) {
        roll -= weight;
        if (roll <= 0) { currentWeather = w; break; }
    }
    const [minMins, maxMins] = WEATHER_DURATIONS[currentWeather];
    weatherChangesAt = Date.now() + (minMins + Math.random() * (maxMins - minMins)) * 60000;
    return true; // weather changed
}

function getWeather() { return { type: currentWeather, changesAt: weatherChangesAt }; }

// ══════════════════════════════════════════════════════════════
//  TREASURE CHEST SYSTEM
// ══════════════════════════════════════════════════════════════

const liveChests = new Map(); // chestId → { id, tier, x, y, spawnedAt }
let chestIdCounter = 0;
const CHEST_TTL = 300000; // 5 min
const CHEST_MAX_NEARBY = 4;
const CHEST_TIERS = [
    { name: 'Wooden Chest',   emoji: '📦', loot: [{ id: 'loot_coin_pouch', w: 30 }, { id: 'potion_health', w: 25 }, { id: 'bait_worm', w: 20 }, { id: 'seed_wheat', w: 15 }, { id: 'loot_feather', w: 10 }], coinRange: [5, 20] },
    { name: 'Silver Chest',   emoji: '🪙', loot: [{ id: 'loot_coin_pouch', w: 20 }, { id: 'potion_health_big', w: 15 }, { id: 'dungeon_key', w: 12 }, { id: 'gem_ruby', w: 15 }, { id: 'loot_crown', w: 10 }, { id: 'food_fish_stew', w: 15 }, { id: 'bar_iron', w: 13 }], coinRange: [15, 50] },
    { name: 'Gold Chest',     emoji: '💰', loot: [{ id: 'gem_emerald', w: 20 }, { id: 'gem_diamond', w: 12 }, { id: 'dungeon_key', w: 15 }, { id: 'loot_egg', w: 10 }, { id: 'bar_gold', w: 15 }, { id: 'food_pumpkin_pie', w: 10 }, { id: 'hat_cowboy', w: 8 }, { id: 'weapon_sword', w: 10 }], coinRange: [30, 100] },
    { name: 'Crystal Chest',  emoji: '💎', loot: [{ id: 'gem_diamond', w: 18 }, { id: 'gem_star', w: 12 }, { id: 'ore_dragonite', w: 10 }, { id: 'loot_star', w: 8 }, { id: 'loot_void_heart', w: 4 }, { id: 'hat_wizard', w: 8 }, { id: 'dungeon_key', w: 15 }, { id: 'food_golden_feast', w: 10 }, { id: 'weapon_katana', w: 5 }, { id: 'bar_mithril', w: 10 }], coinRange: [50, 250] },
];

function spawnChests() {
    const players = getLivePlayers();
    for (const [uid, p] of Object.entries(players)) {
        const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
        if (isInSafeZone(ptx, pty)) continue;
        // Count nearby chests
        let nearby = 0;
        for (const ch of liveChests.values()) {
            if (Math.abs(ch.x - p.x) + Math.abs(ch.y - p.y) < 12 * TILE) nearby++;
        }
        if (nearby >= CHEST_MAX_NEARBY) continue;
        // 15% chance per spawn tick per player
        if (Math.random() > 0.15) continue;

        const angle = Math.random() * Math.PI * 2;
        const dist = (4 + Math.random() * 8) * TILE;
        const cx = p.x + Math.cos(angle) * dist;
        const cy = p.y + Math.sin(angle) * dist;
        const ctx_ = Math.floor(cx / TILE), cty = Math.floor(cy / TILE);
        if (ctx_ < 1 || ctx_ >= MAP_W - 1 || cty < 1 || cty >= MAP_H - 1) continue;
        const biome = getBiomeAt(ctx_, cty, worldSeed);
        if (biome === 'water' || biome === 'outpost') continue;

        const tier = Math.min(3, getDifficultyTier(ctx_, cty));
        const tierNames = ['wooden', 'silver', 'gold', 'crystal'];
        const id = ++chestIdCounter;
        liveChests.set(id, {
            id, tier: tierNames[tier], tierIdx: tier, x: cx, y: cy, spawnedAt: Date.now(),
            name: CHEST_TIERS[tier].name, emoji: CHEST_TIERS[tier].emoji,
        });
    }
}

function openChest(userId, chestId) {
    const chest = liveChests.get(chestId);
    if (!chest) return { error: 'Chest not found.' };
    const p = getPlayer(userId);
    const dist = Math.sqrt((p.x - chest.x) ** 2 + (p.y - chest.y) ** 2);
    if (dist > TILE * 3) return { error: 'Too far away!' };

    const tierData = CHEST_TIERS[chest.tierIdx];
    // Roll 1-3 loot items
    const numItems = 1 + Math.floor(Math.random() * (1 + chest.tier));
    const lootItems = [];
    for (let i = 0; i < numItems; i++) {
        const lootId = rollLoot(tierData.loot.map(l => ({ id: l.id, weight: l.w })));
        addItem(userId, lootId, 1);
        lootItems.push({ id: lootId, ...(ITEMS[lootId] || { name: lootId }) });
    }
    // Bonus coins
    const coins = tierData.coinRange[0] + Math.floor(Math.random() * (tierData.coinRange[1] - tierData.coinRange[0] + 1));
    db.addOpenCoins(userId, coins);

    liveChests.delete(chestId);

    // Track for achievements
    const totalChests = (db.get('SELECT total_chests_opened FROM game_players WHERE user_id = ?', [userId])?.total_chests_opened || 0) + 1;
    db.run('UPDATE game_players SET total_chests_opened = total_chests_opened + 1 WHERE user_id = ?', [userId]);
    incrementDailyQuestStat(userId, 'chests_opened', 1);
    checkAchievement(userId, 'chest_open_1', totalChests >= 1);
    checkAchievement(userId, 'chest_open_25', totalChests >= 25);

    return {
        success: true, chestId,
        tier: chest.tier, name: tierData.name, emoji: tierData.emoji,
        loot: lootItems.map(i => ({ id: i.id, name: i.name, emoji: i.emoji, qty: 1 })), coins,
        x: chest.x, y: chest.y,
    };
}

function cleanupChests() {
    const now = Date.now();
    for (const [id, ch] of liveChests) {
        if (now - ch.spawnedAt > CHEST_TTL) liveChests.delete(id);
    }
}

function getChestStates() {
    const now = Date.now();
    const result = {};
    for (const [id, ch] of liveChests) {
        if (now - ch.spawnedAt > CHEST_TTL) { liveChests.delete(id); continue; }
        result[id] = ch;
    }
    return result;
}

// NPC positions (tile coordinates)
function isNearNPC(userId, npcId) {
    const npc = NPCS[npcId];
    if (!npc) return false;
    const player = getPlayer(userId);
    if (!player) return false;
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    return Math.abs(px - npc.tileX) <= NPC_INTERACT_RANGE && Math.abs(py - npc.tileY) <= NPC_INTERACT_RANGE;
}

function isNearBankNPC(userId) { return isNearNPC(userId, 'banker'); }

function isNearAnyShopNPC(userId) {
    return NPC_LIST.filter(n => n.categories.length > 0).some(n => isNearNPC(userId, n.id));
}

function getNearestNPC(userId) {
    const player = getPlayer(userId);
    if (!player) return null;
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    let best = null, bestDist = Infinity;
    for (const npc of NPC_LIST) {
        const d = Math.abs(px - npc.tileX) + Math.abs(py - npc.tileY);
        if (d <= NPC_INTERACT_RANGE * 2 && d < bestDist) { best = npc; bestDist = d; }
    }
    return best;
}

function getShopItemsForNPC(npcId) {
    const npc = NPCS[npcId];
    if (!npc || !npc.categories.length) return [];
    return Object.entries(ITEMS)
        .filter(([_, i]) => (i.buyCost !== null || i.sellPrice !== null || i.coinPrice) && npc.categories.includes(i.category))
        .map(([id, i]) => ({ id, ...i }));
}

function getSellableItemsForNPC(npcId) {
    const npc = NPCS[npcId];
    if (!npc || !npc.categories.length) return [];
    return Object.entries(ITEMS)
        .filter(([_, i]) => i.sellPrice !== null && npc.categories.includes(i.category))
        .map(([id, i]) => ({ id, ...i }));
}

// ── Ground Items (dropped on death, scattered in world) ──────
const groundItems = new Map(); // groundItemId → { id, itemId, qty, x, y, droppedAt, name, emoji, rarity }
let groundItemIdCounter = 0;
const GROUND_ITEM_TTL = 300000; // 5 min

function dropGroundItem(itemId, qty, x, y, droppedBy = null) {
    const id = ++groundItemIdCounter;
    const item = ITEMS[itemId] || {};
    groundItems.set(id, {
        id, itemId, qty, x, y, droppedAt: Date.now(), droppedBy,
        name: item.name || itemId,
        emoji: item.emoji || '❓',
        rarity: item.rarity || 'Common',
    });
    return id;
}

function pickupGroundItem(userId, groundItemId) {
    const gi = groundItems.get(groundItemId);
    if (!gi) return { error: 'Item not found.' };
    const p = getPlayer(userId);
    const dist = Math.sqrt((p.x - gi.x) ** 2 + (p.y - gi.y) ** 2);
    if (dist > TILE * 2.5) return { error: 'Too far away!' };
    addItem(userId, gi.itemId, gi.qty);
    const result = { success: true, groundId: groundItemId, item: { id: gi.itemId, name: gi.name, emoji: gi.emoji, qty: gi.qty, rarity: gi.rarity } };
    groundItems.delete(groundItemId);
    return result;
}

function getGroundItemStates() {
    const now = Date.now();
    const result = {};
    for (const [id, gi] of groundItems) {
        if (now - gi.droppedAt > GROUND_ITEM_TTL) { groundItems.delete(id); continue; }
        result[id] = gi;
    }
    return result;
}

function cleanupGroundItems() {
    const now = Date.now();
    for (const [id, gi] of groundItems) {
        if (now - gi.droppedAt > GROUND_ITEM_TTL) groundItems.delete(id);
    }
}

// ── Station Proximity Check (furnace, workbench, campfire) ───
function isNearStation(userId, stationType) {
    const p = getPlayer(userId);
    const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
    const nearby = db.all(
        'SELECT id FROM game_structures WHERE type = ? AND ABS(tile_x - ?) <= 3 AND ABS(tile_y - ?) <= 3',
        [stationType, ptx, pty]
    );
    return nearby.length > 0;
}

// ── Resource Node Depletion (in-memory) ──────────────────────
const depletedNodes = new Map(); // "x,y" → respawnTimestamp

function isNodeDepleted(tx, ty) {
    const key = `${tx},${ty}`;
    const t = depletedNodes.get(key);
    if (!t) return false;
    if (Date.now() >= t) { depletedNodes.delete(key); return false; }
    return true;
}

function depleteNode(tx, ty, cooldownMs) {
    depletedNodes.set(`${tx},${ty}`, Date.now() + cooldownMs);
}

function getDepletedNodes() {
    const now = Date.now();
    const result = [];
    for (const [key, t] of depletedNodes) {
        if (now < t) {
            const [x, y] = key.split(',').map(Number);
            result.push({ x, y, respawnAt: t });
        } else {
            depletedNodes.delete(key);
        }
    }
    return result;
}

// ── Init ─────────────────────────────────────────────────────
function initGameDb() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.getDb().exec(schema);

    // Migrations: add columns that may be missing from older schema versions
    const migrations = [
        'ALTER TABLE game_players ADD COLUMN sleeping_bag_x REAL',
        'ALTER TABLE game_players ADD COLUMN sleeping_bag_y REAL',
        'ALTER TABLE game_players ADD COLUMN structures_built INTEGER DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN resources_gathered INTEGER DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN smithing_xp INTEGER DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN agility_xp INTEGER DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN total_chests_opened INTEGER DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN total_tiles_traveled REAL DEFAULT 0',
        'ALTER TABLE game_players ADD COLUMN total_dungeon_wins INTEGER DEFAULT 0',
    ];
    for (const sql of migrations) {
        try { db.getDb().exec(sql); } catch { /* column already exists */ }
    }

    // Fish collection table (Toontown-style)
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS game_fish_collection (
            user_id INTEGER NOT NULL,
            fish_id TEXT NOT NULL,
            times_caught INTEGER DEFAULT 1,
            max_weight REAL DEFAULT 0,
            first_caught DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, fish_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    try { db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_fish_coll_user ON game_fish_collection(user_id)'); } catch { }

    // Achievement tracking table
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS game_achievements (
            user_id INTEGER NOT NULL,
            achievement_id TEXT NOT NULL,
            completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, achievement_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS game_daily_quest_progress (
            user_id INTEGER NOT NULL,
            quest_date TEXT NOT NULL,
            stat_key TEXT NOT NULL,
            value REAL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, quest_date, stat_key),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS game_daily_quest_claims (
            user_id INTEGER NOT NULL,
            quest_date TEXT NOT NULL,
            quest_id TEXT NOT NULL,
            claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, quest_date, quest_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    try { db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_daily_quest_progress_user_date ON game_daily_quest_progress(user_id, quest_date)'); } catch { }
    try { db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_daily_quest_claims_user_date ON game_daily_quest_claims(user_id, quest_date)'); } catch { }

    worldSeed = getWorldSeed();
    console.log(`[OpenVibeGame] Schema initialized, world seed: ${worldSeed}`);
}

function getWorldSeed() {
    let row = db.get("SELECT value FROM game_world_state WHERE key = 'world_seed'");
    if (!row) {
        const seed = Math.floor(Math.random() * 2147483647);
        db.run("INSERT INTO game_world_state (key, value) VALUES ('world_seed', ?)", [String(seed)]);
        return seed;
    }
    return parseInt(row.value, 10);
}

// ══════════════════════════════════════════════════════════════
//  AGILITY — Passive bonus calculator
// ══════════════════════════════════════════════════════════════

function getAgilityBonuses(level) {
    return {
        maxStaminaBonus:  level * 2,                                // +2 max stamina per level
        regenBonus:       Math.floor(level * 0.4),                  // +0.4 regen per 3s tick per level
        sprintDrainMult:  Math.max(0.50, 1.0 - level * 0.02),      // -2% sprint drain / level (min 50%)
        dodgeCostReduct:  Math.min(10, Math.floor(level * 0.5)),    // -0.5 dodge cost / level (max -10)
        swimSpeedMult:    1.0 + level * 0.02,                       // +2% swim speed / level
        sprintSpeedMult:  1.0 + Math.floor(level / 5) * 0.02,      // +2% sprint speed every 5 levels
    };
}

// ══════════════════════════════════════════════════════════════
//  ACHIEVEMENT TRACKING
// ══════════════════════════════════════════════════════════════

function checkAchievement(userId, achievementId, condition) {
    if (!condition) return null;
    if (!ACHIEVEMENTS[achievementId]) return null;
    // Already completed?
    const existing = db.get('SELECT 1 FROM game_achievements WHERE user_id = ? AND achievement_id = ?', [userId, achievementId]);
    if (existing) return null;
    // Award it!
    db.run('INSERT OR IGNORE INTO game_achievements (user_id, achievement_id) VALUES (?, ?)', [userId, achievementId]);
    const ach = ACHIEVEMENTS[achievementId];
    // Grant reward
    if (ach.reward.coins) db.addOpenCoins(userId, ach.reward.coins);
    if (ach.reward.item) addItem(userId, ach.reward.item, ach.reward.qty || 1);
    // Queue notification
    if (!pendingAchievements.has(userId)) pendingAchievements.set(userId, []);
    pendingAchievements.get(userId).push({ id: achievementId, ...ach });
    return { id: achievementId, ...ach };
}

function getAchievements(userId) {
    const completed = db.all('SELECT achievement_id, completed_at FROM game_achievements WHERE user_id = ?', [userId]);
    const completedSet = new Set(completed.map(r => r.achievement_id));
    const all = Object.entries(ACHIEVEMENTS).map(([id, a]) => ({
        id, ...a,
        completed: completedSet.has(id),
        completedAt: completed.find(r => r.achievement_id === id)?.completed_at || null,
    }));
    return { achievements: all, completed: completed.length, total: Object.keys(ACHIEVEMENTS).length };
}

function flushPendingAchievements(userId) {
    const list = pendingAchievements.get(userId) || [];
    pendingAchievements.delete(userId);
    return list;
}

/** Check level-based achievements after any XP gain */
function checkLevelAchievements(userId) {
    const p = getPlayer(userId);
    const skills = ['mining', 'fishing', 'woodcut', 'farming', 'combat', 'crafting', 'smithing', 'agility'];
    const levels = skills.map(s => xpToLevel(p[`${s}_xp`] || 0));
    const maxLevel = Math.max(...levels);
    const totalLevel = levels.reduce((a, b) => a + b, 0);
    checkAchievement(userId, 'level_10_any', maxLevel >= 10);
    checkAchievement(userId, 'level_25_any', maxLevel >= 25);
    checkAchievement(userId, 'level_50_any', maxLevel >= 50);
    checkAchievement(userId, 'total_level_50', totalLevel >= 50);
    checkAchievement(userId, 'total_level_100', totalLevel >= 100);
}

// ══════════════════════════════════════════════════════════════
//  PLAYER
// ══════════════════════════════════════════════════════════════

function getPlayer(userId) {
    let p = db.get('SELECT * FROM game_players WHERE user_id = ?', [userId]);
    if (!p) {
        // Spawn at outpost center
        const sx = OUTPOST_X * TILE + TILE / 2;
        const sy = OUTPOST_Y * TILE + TILE / 2;
        db.run('INSERT INTO game_players (user_id, x, y) VALUES (?, ?, ?)', [userId, sx, sy]);
        p = db.get('SELECT * FROM game_players WHERE user_id = ?', [userId]);
    }
    p.mining_level = xpToLevel(p.mining_xp);
    p.fishing_level = xpToLevel(p.fishing_xp);
    p.woodcut_level = xpToLevel(p.woodcut_xp);
    p.farming_level = xpToLevel(p.farming_xp);
    p.combat_level = xpToLevel(p.combat_xp);
    p.crafting_level = xpToLevel(p.crafting_xp);
    p.smithing_level = xpToLevel(p.smithing_xp || 0);
    p.agility_level = xpToLevel(p.agility_xp || 0);
    p.total_level = p.mining_level + p.fishing_level + p.woodcut_level +
                    p.farming_level + p.combat_level + p.crafting_level +
                    p.smithing_level + p.agility_level;
    // Apply agility max_stamina bonus: +2 per agility level
    const agilBonus = getAgilityBonuses(p.agility_level);
    p.max_stamina = 100 + agilBonus.maxStaminaBonus;
    return p;
}

function updatePlayerPosition(userId, x, y) {
    db.run('UPDATE game_players SET x = ?, y = ?, last_action = CURRENT_TIMESTAMP WHERE user_id = ?', [x, y, userId]);
}

function addXp(userId, skill, amount) {
    const col = `${skill}_xp`;
    const p = getPlayer(userId);
    const oldLevel = xpToLevel(p[col]);
    db.run(`UPDATE game_players SET ${col} = ${col} + ?, last_action = CURRENT_TIMESTAMP WHERE user_id = ?`, [amount, userId]);
    const newXp = p[col] + amount;
    const newLevel = xpToLevel(newXp);
    // Check level-based achievements on level up
    if (newLevel > oldLevel) checkLevelAchievements(userId);
    return { oldLevel, newLevel, leveledUp: newLevel > oldLevel, xp: newXp, totalXp: amount };
}

function regenStamina(userId) {
    const p = db.get('SELECT stamina, max_stamina, last_stamina_tick FROM game_players WHERE user_id = ?', [userId]);
    if (!p) return 0;
    const now = Date.now();
    let lastTick;
    try { lastTick = new Date(p.last_stamina_tick.replace(' ', 'T') + 'Z').getTime(); }
    catch { lastTick = now - 30000; }
    const regen = Math.floor((now - lastTick) / 1000 / 30);
    if (regen > 0 && p.stamina < p.max_stamina) {
        const newSta = Math.min(p.max_stamina, p.stamina + regen);
        db.run('UPDATE game_players SET stamina = ?, last_stamina_tick = CURRENT_TIMESTAMP WHERE user_id = ?', [newSta, userId]);
        return newSta;
    }
    return p.stamina;
}

/**
 * Continuous stamina regen tick — called every ~3s from server tick.
 * Returns an array of { userId, stamina, maxStamina } for players whose stamina changed.
 */
function regenStaminaTick() {
    const players = getLivePlayers();
    const updates = [];
    for (const [uid, lp] of Object.entries(players)) {
        const userId = parseInt(uid);
        const pd = getPlayer(userId);
        if (!pd) continue;

        const maxSta = pd.max_stamina;
        if (pd.stamina >= maxSta) continue; // Already full

        // Base regen: 3 per tick, boosted by agility
        const bonuses = getAgilityBonuses(pd.agility_level);
        let regen = 3 + bonuses.regenBonus;

        // Halve regen if currently sprinting
        if (sprintingPlayers.has(userId)) regen = Math.max(1, Math.floor(regen / 2));

        const newSta = Math.min(maxSta, pd.stamina + regen);
        if (newSta !== pd.stamina) {
            db.run('UPDATE game_players SET stamina = ?, last_stamina_tick = CURRENT_TIMESTAMP WHERE user_id = ?', [newSta, userId]);
            updates.push({ userId, stamina: newSta, maxStamina: maxSta });
        }
    }
    // Clear sprint tracking for this tick (will be re-set by next movement)
    sprintingPlayers.clear();
    return updates;
}

// ══════════════════════════════════════════════════════════════
//  INVENTORY
// ══════════════════════════════════════════════════════════════

function getInventory(userId) {
    return db.all('SELECT item_id, quantity FROM game_inventory WHERE user_id = ? AND quantity > 0', [userId])
        .map(r => ({ ...r, ...(ITEMS[r.item_id] || { name: r.item_id, emoji: '❓', rarity: 'Common' }) }));
}

function getItemCount(userId, itemId) {
    const r = db.get('SELECT quantity FROM game_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    return r ? r.quantity : 0;
}

function addItem(userId, itemId, qty = 1) {
    db.run(`INSERT INTO game_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)
            ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + ?`, [userId, itemId, qty, qty]);
    // Auto-unlock hats as global cosmetics so they show as chat badges
    const item = ITEMS[itemId];
    if (item?.category === 'hats') {
        try { cosmeticsSystem.unlockCosmetic(userId, itemId); } catch {}
    }
}

function removeItem(userId, itemId, qty = 1) {
    const cur = getItemCount(userId, itemId);
    if (cur < qty) return false;
    if (cur === qty) db.run('DELETE FROM game_inventory WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    else db.run('UPDATE game_inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [qty, userId, itemId]);
    return true;
}

function hasItem(userId, itemId, qty = 1) { return getItemCount(userId, itemId) >= qty; }

// ══════════════════════════════════════════════════════════════
//  BANK
// ══════════════════════════════════════════════════════════════

function getBank(userId) {
    return db.all('SELECT item_id, quantity FROM game_bank WHERE user_id = ? AND quantity > 0', [userId])
        .map(r => ({ ...r, ...(ITEMS[r.item_id] || { name: r.item_id, emoji: '❓', rarity: 'Common' }) }));
}

function bankDeposit(userId, itemId, qty = 1) {
    if (!removeItem(userId, itemId, qty)) return false;
    db.run(`INSERT INTO game_bank (user_id, item_id, quantity) VALUES (?, ?, ?)
            ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + ?`, [userId, itemId, qty, qty]);
    return true;
}

function bankWithdraw(userId, itemId, qty = 1) {
    const r = db.get('SELECT quantity FROM game_bank WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    if (!r || r.quantity < qty) return false;
    if (r.quantity === qty) db.run('DELETE FROM game_bank WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    else db.run('UPDATE game_bank SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?', [qty, userId, itemId]);
    addItem(userId, itemId, qty);
    return true;
}

// ══════════════════════════════════════════════════════════════
//  SHOP
// ══════════════════════════════════════════════════════════════

function getShopItems() {
    return Object.entries(ITEMS).filter(([_, i]) => i.buyCost !== null).map(([id, i]) => ({ id, ...i }));
}

function buyItem(userId, itemId, qty = 1) {
    const item = ITEMS[itemId];
    if (!item || item.buyCost === null) return { error: 'Not for sale' };
    const cost = item.buyCost * qty;
    const user = db.getUserById(userId);
    if (!user || user.openvibe_coins_balance < cost) return { error: 'Not enough gold' };

    // Check level requirement before buying equipment
    const slot = EQUIPMENT_SLOTS[item.category];
    if (slot && item.levelReq) {
        const skillName = EQUIP_SKILL_MAP[item.category];
        if (skillName) {
            const p = getPlayer(userId);
            const playerLevel = xpToLevel(p[`${skillName}_xp`]);
            if (playerLevel < item.levelReq) {
                return { error: `Need ${skillName.charAt(0).toUpperCase() + skillName.slice(1)} level ${item.levelReq} to use this! (You're level ${playerLevel})` };
            }
        }
    }

    if (!db.deductOpenCoins(userId, cost)) return { error: 'Not enough gold' };
    addItem(userId, itemId, qty);

    // Auto-equip tools/equipment after buying (if it's equippable and better or slot is empty)
    let autoEquipped = false;
    if (slot && qty === 1) {
        const p = getPlayer(userId);
        const currentEquip = p[slot];
        // Auto-equip if the slot is empty or upgrading to a better item
        if (!currentEquip || isBetterEquipment(currentEquip, itemId, item.category)) {
            db.run(`UPDATE game_players SET ${slot} = ? WHERE user_id = ?`, [itemId, userId]);
            recalcCombatStats(userId);
            autoEquipped = true;
        }
    }

    return { success: true, item: { id: itemId, ...item }, qty, cost, autoEquipped, slot: autoEquipped ? item.category : null };
}

function sellItem(userId, itemId, qty = 1) {
    const item = ITEMS[itemId];
    if (!item || item.sellPrice === null) return { error: 'Cannot sell' };
    if (!removeItem(userId, itemId, qty)) return { error: 'Not enough items' };
    const earned = item.sellPrice * qty;
    db.addOpenCoins(userId, earned);
    return { success: true, item: { id: itemId, ...item }, qty, earned };
}

function buyWithCoins(userId, itemId) {
    const item = ITEMS[itemId];
    if (!item || !item.coinPrice) return { error: 'Not for coin sale' };
    const user = db.getUserById(userId);
    if (!user || user.openvibe_coins_balance < item.coinPrice) return { error: 'Not enough OpenCoins' };
    if (!db.deductOpenCoins(userId, item.coinPrice)) return { error: 'Not enough OpenCoins' };
    addItem(userId, itemId, 1);
    return { success: true, item: { id: itemId, ...item }, cost: item.coinPrice };
}

function getCoinShopItems() {
    return Object.entries(ITEMS).filter(([_, i]) => i.coinPrice).map(([id, i]) => ({ id, ...i }));
}

// ══════════════════════════════════════════════════════════════
//  GATHERING (open-world resource nodes)
// ══════════════════════════════════════════════════════════════

function gather(userId, tileX, tileY) {
    const player = getPlayer(userId);
    regenStamina(userId);
    const sta = db.get('SELECT stamina FROM game_players WHERE user_id = ?', [userId]).stamina;

    // Proximity check (player tile vs target tile)
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    if (Math.abs(px - tileX) > 2 || Math.abs(py - tileY) > 2) return { error: 'Too far away!' };

    const node = getResourceNodeAt(tileX, tileY, worldSeed);
    if (!node) return { error: 'Nothing to gather here.' };
    if (isNodeDepleted(tileX, tileY)) return { error: 'Depleted. Come back soon.' };

    let skill, action;
    if (node.type === 'tree') { skill = 'woodcut'; action = 'chop'; }
    else if (node.type === 'rock') { skill = 'mining'; action = 'mine'; }
    else { return { error: 'Cannot gather this.' }; }

    // ── FIST PUNCHING (no tool) ──
    // Without proper tools, you can only punch stone rocks or basic trees for raw materials
    const equippedPick = player.equip_pickaxe;
    const equippedAxe = player.equip_axe;

    if (node.type === 'rock') {
        // Require pickaxe equipped to mine any rock
        if (!equippedPick) return { error: 'You need a pickaxe equipped to mine! ⛏️' };

        const oreType = node.ore || 'stone';
        const oreInfo = ORE_NODE_TYPES[oreType];
        const pickTier = equippedPick ? (PICK_TIERS[equippedPick]?.tier ?? -1) : -1;

        // Check mining level requirement
        if (oreInfo && oreInfo.minLevel && player.mining_level < oreInfo.minLevel) {
            return { error: `Need Mining level ${oreInfo.minLevel} to mine ${oreInfo.name}! (You're level ${player.mining_level})` };
        }

        if (oreInfo && pickTier < oreInfo.minPickTier) {
            const needed = Object.entries(PICK_TIERS).find(([_, v]) => v.tier >= oreInfo.minPickTier);
            return { error: `Need ${needed ? ITEMS[needed[0]]?.name || needed[1].name : 'a better'} pickaxe to mine ${oreInfo.name}!` };
        }
    }

    if (node.type === 'tree') {
        if (!equippedAxe) {
            // Fist punching trees: gives raw_stick, more stamina
            if (sta < 10) return { error: 'Not enough stamina!' };
            db.run('UPDATE game_players SET stamina = stamina - 10 WHERE user_id = ?', [userId]);
            addItem(userId, 'raw_stick', 1);
            depleteNode(tileX, tileY, 12000);
            const xpResult = addXp(userId, 'woodcut', 2);
            db.run('UPDATE game_players SET resources_gathered = resources_gathered + 1 WHERE user_id = ?', [userId]);
            incrementDailyQuestStat(userId, 'gather_count', 1);
            return {
                success: true, action: 'punch',
                loot: { id: 'raw_stick', ...(ITEMS['raw_stick'] || {}) },
                bonus: false, xp: xpResult, toolBroke: false,
                stamina: sta - 10, depletedUntil: Date.now() + 12000,
                tileX, tileY,
            };
        }
    }

    // ── NORMAL GATHERING (with tools) ──
    const staCost = node.type === 'rock' ? 8 : node.type === 'tree' ? 6 : 5;
    if (sta < staCost) return { error: 'Not enough stamina!' };

    db.run('UPDATE game_players SET stamina = stamina - ? WHERE user_id = ?', [staCost, userId]);

    const tier = getDifficultyTier(tileX, tileY);

    let lootId, item;
    if (node.type === 'rock') {
        // Ore-specific loot: pick from the appropriate ore table based on node subtype
        const oreType = node.ore || 'stone';
        const oreLootMap = {
            stone:    ['ore_gravel', 'ore_coal', 'raw_stone'],
            tin:      ['ore_tin'],
            copper:   ['ore_copper'],
            coal:     ['ore_coal'],
            iron:     ['ore_iron'],
            gold:     ['ore_gold'],
            mithril:  ['ore_mithril'],
            titanium: ['ore_titanium'],
            platinum: ['ore_platinum'],
            dragonite:['ore_dragonite'],
        };
        const primaryOres = oreLootMap[oreType] || ['ore_gravel'];
        // Primary ore (70%), or tier-based bonus from MINE_TABLES (30%)
        if (Math.random() < 0.70 || !MINE_TABLES[Math.min(tier, 3)]) {
            lootId = primaryOres[Math.floor(Math.random() * primaryOres.length)];
        } else {
            lootId = rollLoot(MINE_TABLES[Math.min(tier, 3)]);
        }
        item = ITEMS[lootId];
    } else {
        const tables = { tree: WOOD_TABLES };
        const table = tables[node.type]?.[Math.min(tier, 3)] || tables[node.type]?.[0];
        if (!table) return { error: 'Cannot gather here.' };
        lootId = rollLoot(table);
        item = ITEMS[lootId];
    }

    addItem(userId, lootId, 1);

    // Bonus drop (12% chance for rocks)
    let bonus = false;
    if (node.type === 'rock' && Math.random() < 0.12) { addItem(userId, lootId, 1); bonus = true; }

    const baseXp = (item?.sellPrice || 5) + 5 + tier * 3;
    const xpResult = addXp(userId, skill, baseXp);

    // Tool break (3%) — only for non-starter tools
    let toolBroke = false;
    const toolSlots = { woodcut: 'equip_axe', mining: 'equip_pickaxe', fishing: 'equip_rod' };
    const slot = toolSlots[skill];
    if (slot && player[slot] && Math.random() < 0.03) {
        toolBroke = player[slot];
        db.run(`UPDATE game_players SET ${slot} = NULL WHERE user_id = ?`, [userId]);
    }

    const cooldown = node.type === 'tree' ? 25000 : node.type === 'rock' ? 40000 : 18000;
    depleteNode(tileX, tileY, cooldown);

    db.run('UPDATE game_players SET resources_gathered = resources_gathered + 1 WHERE user_id = ?', [userId]);
    incrementDailyQuestStat(userId, 'gather_count', 1);

    // Achievement checks
    const totalGathered = (db.get('SELECT resources_gathered FROM game_players WHERE user_id = ?', [userId])?.resources_gathered || 0);
    checkAchievement(userId, 'first_gather', totalGathered >= 1);
    checkAchievement(userId, 'gather_100', totalGathered >= 100);
    checkAchievement(userId, 'gather_500', totalGathered >= 500);
    if (lootId === 'ore_dragonite') checkAchievement(userId, 'dragonite_found', true);
    if (lootId === 'wood_crystal') checkAchievement(userId, 'crystal_wood', true);

    return {
        success: true, action,
        loot: { id: lootId, ...(item || {}) },
        bonus, xp: xpResult, toolBroke,
        stamina: sta - staCost,
        depletedUntil: Date.now() + cooldown,
        tileX, tileY,
        oreType: node.ore || undefined,
    };
}

// ══════════════════════════════════════════════════════════════
//  FISHING (Toontown-style — cast targeting + reel mini-game)
// ══════════════════════════════════════════════════════════════

function fish(userId, tileX, tileY, reelScore) {
    const player = getPlayer(userId);
    regenStamina(userId);
    const sta = db.get('SELECT stamina FROM game_players WHERE user_id = ?', [userId]).stamina;

    // Proximity check
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    if (Math.abs(px - tileX) > 2 || Math.abs(py - tileY) > 2) return { error: 'Too far away!' };

    // Must be a water tile
    const biome = getBiomeAt(tileX, tileY, worldSeed);
    if (biome !== 'water') return { error: 'You need to cast into water!' };

    // Must have a fishing rod equipped
    if (!player.equip_rod) return { error: 'Equip a fishing rod first! (Buy one from the Tool Merchant)' };

    // Rod tier info
    const rodInfo = ROD_TIERS[player.equip_rod] || ROD_TIERS.rod_bamboo;
    const rodTier = rodInfo.tier;
    const staCost = rodInfo.staminaCost;
    if (sta < staCost) return { error: `Not enough stamina! (Need ${staCost})` };
    db.run('UPDATE game_players SET stamina = stamina - ? WHERE user_id = ?', [staCost, userId]);

    // Validate reel score (0 = miss, 1-3 = catch quality)
    const reel = Math.max(0, Math.min(3, Math.floor(Number(reelScore) || 0)));

    // Fish escaped (reel score 0 — missed all timing windows)
    if (reel === 0) {
        return {
            success: true, action: 'fish', zone: getWaterZone(tileX, tileY, worldSeed),
            escaped: true, message: 'The fish got away!',
            stamina: sta - staCost, tileX, tileY,
        };
    }

    // Determine water zone
    const zone = getWaterZone(tileX, tileY, worldSeed);

    // Build loot table filtered by rod tier + zone
    const table = buildFishTable(zone, rodTier);
    if (!table.length) return { error: 'No fish here!' };

    // Roll loot
    const lootId = rollLoot(table);
    const item = ITEMS[lootId];
    const spec = FISH_SPECIES[lootId];

    // Calculate weight (only for actual fish, not junk)
    let weight = 0;
    if (spec) {
        // Weight based on reel score: 1=low range, 2=mid range, 3=high range
        const range = spec.maxW - spec.minW;
        const reelFactor = (reel - 1) / 2; // 0, 0.5, 1
        const randomFactor = Math.random() * 0.3; // 0-30% extra variance
        weight = Math.round((spec.minW + range * (reelFactor * 0.7 + randomFactor)) * 10) / 10;
        weight = Math.max(spec.minW, Math.min(spec.maxW, weight));
    }

    addItem(userId, lootId, 1);

    // XP scales with fish value + weight bonus
    const baseXp = (item?.sellPrice || 5) + Math.floor(weight * 2);
    const xpResult = addXp(userId, 'fishing', baseXp);
    db.run('UPDATE game_players SET resources_gathered = resources_gathered + 1 WHERE user_id = ?', [userId]);
    incrementDailyQuestStat(userId, 'fish_count', 1);

    // Record in fish collection (only real fish, not junk)
    let newSpecies = false;
    let collectionCount = 0;
    let milestone = null;
    if (spec) {
        const caught = recordFishCatch(userId, lootId, weight);
        newSpecies = caught.newSpecies;
        collectionCount = caught.collectionCount;
        // Milestones at 5, 10, 15, 20, 25, 30
        const milestoneThresholds = [5, 10, 15, 20, 25, 30];
        for (const threshold of milestoneThresholds) {
            if (collectionCount === threshold) {
                // Bonus XP + max HP boost
                const bonusXp = threshold * 10;
                addXp(userId, 'fishing', bonusXp);
                db.run('UPDATE game_players SET max_hp = max_hp + 5, hp = MIN(hp + 5, max_hp + 5) WHERE user_id = ?', [userId]);
                milestone = { threshold, bonusXp, hpBoost: 5, total: collectionCount };
                break;
            }
        }
        // Fish achievements
        checkAchievement(userId, 'first_catch', true);
        checkAchievement(userId, 'fish_species_10', collectionCount >= 10);
        checkAchievement(userId, 'fish_species_20', collectionCount >= 20);
        checkAchievement(userId, 'fish_species_all', collectionCount >= Object.keys(FISH_SPECIES).length);
        if (spec.family === 'Legendary') checkAchievement(userId, 'legendary_catch', true);
    }

    // Rod break (2% — bamboo is unbreakable)
    let toolBroke = false;
    if (Math.random() < 0.02 && player.equip_rod !== 'rod_bamboo') {
        toolBroke = player.equip_rod;
        db.run('UPDATE game_players SET equip_rod = ? WHERE user_id = ?', ['rod_bamboo', userId]);
    }

    // Sell price bonus from weight
    const sellValue = (item?.sellPrice || 1) + Math.floor(weight * 2);

    return {
        success: true, action: 'fish', zone,
        loot: { id: lootId, ...(item || {}), weight, sellValue },
        reelScore: reel, newSpecies, collectionCount, milestone,
        xp: xpResult, toolBroke,
        stamina: sta - staCost, tileX, tileY,
    };
}

// Record a fish catch in the collection album
function recordFishCatch(userId, fishId, weight) {
    const existing = db.get(
        'SELECT * FROM game_fish_collection WHERE user_id = ? AND fish_id = ?',
        [userId, fishId]
    );
    if (existing) {
        const newMax = Math.max(existing.max_weight, weight);
        db.run(
            'UPDATE game_fish_collection SET times_caught = times_caught + 1, max_weight = ? WHERE user_id = ? AND fish_id = ?',
            [newMax, userId, fishId]
        );
    } else {
        db.run(
            'INSERT INTO game_fish_collection (user_id, fish_id, times_caught, max_weight) VALUES (?, ?, 1, ?)',
            [userId, fishId, weight]
        );
    }
    const countRow = db.get('SELECT COUNT(*) as cnt FROM game_fish_collection WHERE user_id = ?', [userId]);
    return { newSpecies: !existing, collectionCount: countRow.cnt };
}

// Get a player's full fish collection for the album UI
function getFishCollection(userId) {
    const rows = db.all(
        'SELECT fish_id, times_caught, max_weight, first_caught FROM game_fish_collection WHERE user_id = ? ORDER BY first_caught ASC',
        [userId]
    );
    const totalSpecies = Object.keys(FISH_SPECIES).length;
    return {
        collected: rows,
        totalSpecies,
        progress: rows.length,
    };
}

function useSonar(userId, tileX, tileY) {
    const player = getPlayer(userId);
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    if (Math.abs(px - tileX) > 3 || Math.abs(py - tileY) > 3) return { error: 'Too far away!' };

    if (!hasItem(userId, 'fish_sonar', 1)) return { error: 'You need a Fish Sonar! Craft one: 2x Copper Ore + 1x Ruby.' };
    if (!removeItem(userId, 'fish_sonar', 1)) return { error: 'No sonar in inventory!' };

    // Scan nearby water tiles for zones
    const zones = {};
    for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
            const cx = tileX + dx, cy = tileY + dy;
            const b = getBiomeAt(cx, cy, worldSeed);
            if (b === 'water') {
                const z = getWaterZone(cx, cy, worldSeed);
                if (!zones[z]) {
                    const table = WATER_ZONE_TABLES[z] || WATER_ZONE_TABLES.shallow;
                    zones[z] = {
                        zone: z,
                        fish: table.map(f => ({ id: f.id, name: ITEMS[f.id]?.name || f.id, emoji: ITEMS[f.id]?.emoji || '🐟', rarity: ITEMS[f.id]?.rarity || 'Common', weight: f.weight })),
                    };
                }
            }
        }
    }
    return { success: true, zones: Object.values(zones) };
}

// ══════════════════════════════════════════════════════════════
//  BUILDING
// ══════════════════════════════════════════════════════════════

function placeStructure(userId, structureType, tileX, tileY) {
    const struct = STRUCTURES[structureType];
    if (!struct) return { error: 'Unknown structure.' };

    const biome = getBiomeAt(tileX, tileY, worldSeed);
    if (biome === 'water') return { error: 'Cannot build on water.' };
    if (isInSafeZone(tileX, tileY)) return { error: 'Cannot build in Town.' };

    const existing = db.get('SELECT id FROM game_structures WHERE tile_x = ? AND tile_y = ?', [tileX, tileY]);
    if (existing) return { error: 'Tile occupied.' };

    const node = getResourceNodeAt(tileX, tileY, worldSeed);
    if (node && !isNodeDepleted(tileX, tileY)) return { error: 'Clear the resource first.' };

    // Check proximity
    const player = getPlayer(userId);
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    if (Math.abs(px - tileX) > 3 || Math.abs(py - tileY) > 3) return { error: 'Too far away!' };

    // Check materials
    for (const [itemId, qty] of Object.entries(struct.cost)) {
        if (!hasItem(userId, itemId, qty)) {
            const item = ITEMS[itemId] || { name: itemId };
            return { error: `Need ${qty}x ${item.name}` };
        }
    }
    for (const [itemId, qty] of Object.entries(struct.cost)) removeItem(userId, itemId, qty);

    db.run(`INSERT INTO game_structures (owner_id, type, tile_x, tile_y, hp, max_hp) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, structureType, tileX, tileY, struct.hp, struct.hp]);

    if (structureType === 'sleeping_bag') {
        db.run('UPDATE game_players SET sleeping_bag_x = ?, sleeping_bag_y = ? WHERE user_id = ?',
            [tileX * TILE + TILE / 2, tileY * TILE + TILE / 2, userId]);
    }

    db.run('UPDATE game_players SET structures_built = structures_built + 1 WHERE user_id = ?', [userId]);
    incrementDailyQuestStat(userId, 'structures_built', 1);
    const xpResult = addXp(userId, 'crafting', 15);

    // Achievement check
    const totalBuilt = db.get('SELECT structures_built FROM game_players WHERE user_id = ?', [userId])?.structures_built || 0;
    checkAchievement(userId, 'build_10', totalBuilt >= 10);

    const id = db.get('SELECT last_insert_rowid() as id').id;
    return {
        success: true,
        structure: { id, type: structureType, ...struct, tile_x: tileX, tile_y: tileY, owner_id: userId, hp: struct.hp, max_hp: struct.hp },
        xp: xpResult,
    };
}

function destroyStructure(userId, tileX, tileY) {
    const s = db.get('SELECT * FROM game_structures WHERE tile_x = ? AND tile_y = ?', [tileX, tileY]);
    if (!s) return { error: 'No structure here.' };
    if (s.owner_id !== userId) return { error: 'Not your structure.' };
    db.run('DELETE FROM game_structures WHERE id = ?', [s.id]);
    // Refund 50% materials
    const struct = STRUCTURES[s.type];
    if (struct) {
        for (const [itemId, qty] of Object.entries(struct.cost)) {
            addItem(userId, itemId, Math.ceil(qty / 2));
        }
    }
    return { success: true, tileX, tileY };
}

function getStructuresInArea(minX, minY, maxX, maxY) {
    return db.all('SELECT * FROM game_structures WHERE tile_x >= ? AND tile_x <= ? AND tile_y >= ? AND tile_y <= ?',
        [minX, maxX, minY, maxY]);
}

function getAllStructures() {
    return db.all('SELECT * FROM game_structures');
}

// Storage box operations
function storageDeposit(userId, structureId, itemId, qty) {
    const s = db.get('SELECT * FROM game_structures WHERE id = ? AND type = ?', [structureId, 'storage_box']);
    if (!s) return { error: 'Not a storage box.' };
    if (s.owner_id !== userId) return { error: 'Not yours.' };
    if (!removeItem(userId, itemId, qty)) return { error: 'Not enough items.' };
    const data = JSON.parse(s.data || '{}');
    if (!data.items) data.items = [];
    const ex = data.items.find(i => i.item_id === itemId);
    if (ex) ex.quantity += qty; else data.items.push({ item_id: itemId, quantity: qty });
    db.run('UPDATE game_structures SET data = ? WHERE id = ?', [JSON.stringify(data), structureId]);
    return { success: true, storage: data.items };
}

function storageWithdraw(userId, structureId, itemId, qty) {
    const s = db.get('SELECT * FROM game_structures WHERE id = ? AND type = ?', [structureId, 'storage_box']);
    if (!s) return { error: 'Not a storage box.' };
    if (s.owner_id !== userId) return { error: 'Not yours.' };
    const data = JSON.parse(s.data || '{}');
    const ex = (data.items || []).find(i => i.item_id === itemId);
    if (!ex || ex.quantity < qty) return { error: 'Not enough in storage.' };
    ex.quantity -= qty;
    if (ex.quantity <= 0) data.items = data.items.filter(i => i.item_id !== itemId);
    db.run('UPDATE game_structures SET data = ? WHERE id = ?', [JSON.stringify(data), structureId]);
    addItem(userId, itemId, qty);
    return { success: true, storage: data.items };
}

// ══════════════════════════════════════════════════════════════
//  FARMING
// ══════════════════════════════════════════════════════════════

function getFarmPlots(userId) {
    const plots = db.all('SELECT * FROM game_farm_plots WHERE user_id = ? ORDER BY plot_index', [userId]);
    if (plots.length < 2) {
        for (let i = plots.length; i < 2; i++)
            db.run('INSERT OR IGNORE INTO game_farm_plots (user_id, plot_index) VALUES (?, ?)', [userId, i]);
        return db.all('SELECT * FROM game_farm_plots WHERE user_id = ? ORDER BY plot_index', [userId]);
    }
    return plots.map(p => {
        if (p.crop_id && !['empty', 'ripe', 'withered'].includes(p.stage)) p.stage = computeGrowthStage(p);
        return p;
    });
}

function computeGrowthStage(plot) {
    if (!plot.planted_at || !plot.crop_id) return 'empty';
    const cd = CROPS[plot.crop_id]; if (!cd) return 'empty';
    let plantedAt; try { plantedAt = new Date(plot.planted_at.replace(' ', 'T') + 'Z').getTime(); } catch { return 'empty'; }
    const elapsed = Date.now() - plantedAt;
    const wBonus = plot.watered_at ? 0.8 : 1.0;
    const t = cd.growTime * wBonus;
    if (elapsed >= t * 1.5) return 'withered';
    if (elapsed >= t) return 'ripe';
    if (elapsed >= t * 0.6) return 'growing';
    if (elapsed >= t * 0.3) return 'sprout';
    return 'seed';
}

function plant(userId, plotIndex, seedId) {
    if (!CROPS[seedId]) return { error: 'Invalid seed.' };
    if (!removeItem(userId, seedId, 1)) return { error: 'No seeds!' };
    const plot = db.get('SELECT * FROM game_farm_plots WHERE user_id = ? AND plot_index = ?', [userId, plotIndex]);
    if (!plot) return { error: 'Invalid plot.' };
    if (plot.stage !== 'empty' && plot.stage !== 'withered') return { error: 'Plot occupied!' };
    db.run(`UPDATE game_farm_plots SET crop_id = ?, planted_at = CURRENT_TIMESTAMP, watered_at = NULL, fertilized = 0, stage = 'seed' WHERE user_id = ? AND plot_index = ?`,
        [seedId, userId, plotIndex]);
    return { success: true, plotIndex, seed: seedId };
}

function water(userId, plotIndex) {
    const p = db.get('SELECT * FROM game_farm_plots WHERE user_id = ? AND plot_index = ?', [userId, plotIndex]);
    if (!p || !p.crop_id) return { error: 'Nothing planted!' };
    if (p.watered_at) return { error: 'Already watered!' };
    db.run('UPDATE game_farm_plots SET watered_at = CURRENT_TIMESTAMP WHERE user_id = ? AND plot_index = ?', [userId, plotIndex]);
    return { success: true, xp: addXp(userId, 'farming', 5) };
}

function harvest(userId, plotIndex) {
    const p = db.get('SELECT * FROM game_farm_plots WHERE user_id = ? AND plot_index = ?', [userId, plotIndex]);
    if (!p || !p.crop_id) return { error: 'Nothing planted!' };
    const stage = computeGrowthStage(p);
    if (stage !== 'ripe') return { error: `Crop is ${stage}.` };
    const cd = CROPS[p.crop_id];
    let qty = cd.yield[0] + Math.floor(Math.random() * (cd.yield[1] - cd.yield[0] + 1));
    if (p.fertilized) qty *= 2;
    addItem(userId, cd.output, qty);
    db.run(`UPDATE game_farm_plots SET crop_id = NULL, planted_at = NULL, watered_at = NULL, fertilized = 0, stage = 'empty' WHERE user_id = ? AND plot_index = ?`,
        [userId, plotIndex]);
    return { success: true, crop: cd.output, qty, xp: addXp(userId, 'farming', 15 + qty * 5) };
}

// ══════════════════════════════════════════════════════════════
//  CRAFTING
// ══════════════════════════════════════════════════════════════

function getUnlockedRecipes(userId) {
    const unlocked = db.all('SELECT recipe_id FROM game_recipes WHERE user_id = ?', [userId]);
    const ids = new Set(unlocked.map(r => r.recipe_id));
    for (const [id, r] of Object.entries(RECIPES)) { if (r.rarity === 'Common') ids.add(id); }
    return Array.from(ids).map(id => {
        const recipe = RECIPES[id];
        if (!recipe) return null;
        const outputItem = ITEMS[recipe.output] || {};
        const inputDetails = {};
        for (const [itemId, qty] of Object.entries(recipe.inputs)) {
            const item = ITEMS[itemId] || {};
            inputDetails[itemId] = { name: item.name || itemId, emoji: item.emoji || '❓', qty };
        }
        return { id, ...recipe, outputEmoji: outputItem.emoji || '❓', outputCategory: outputItem.category || 'crafted', inputDetails };
    }).filter(Boolean);
}

function craft(userId, recipeId) {
    const recipe = RECIPES[recipeId];
    if (!recipe) return { error: 'Unknown recipe.' };
    const unlocked = db.get('SELECT id FROM game_recipes WHERE user_id = ? AND recipe_id = ?', [userId, recipeId]);
    if (!unlocked && recipe.rarity !== 'Common') return { error: 'Recipe not unlocked!' };

    // Station requirement check (furnace, workbench, campfire)
    if (recipe.station) {
        if (!isNearStation(userId, recipe.station)) {
            const stationNames = { furnace: 'Furnace 🔥', workbench: 'Workbench 🔨', campfire: 'Campfire 🔥' };
            return { error: `Need to be near a ${stationNames[recipe.station] || recipe.station}!` };
        }
    }

    // Smithing level check
    if (recipe.smithingLevel) {
        const p = getPlayer(userId);
        if (p.smithing_level < recipe.smithingLevel) {
            return { error: `Need Smithing level ${recipe.smithingLevel}! (You're level ${p.smithing_level})` };
        }
    }

    for (const [itemId, qty] of Object.entries(recipe.inputs)) {
        if (!hasItem(userId, itemId, qty)) return { error: `Need ${qty}x ${(ITEMS[itemId] || {}).name || itemId}` };
    }
    for (const [itemId, qty] of Object.entries(recipe.inputs)) removeItem(userId, itemId, qty);
    addItem(userId, recipe.output, recipe.qty);
    db.run('UPDATE game_players SET total_items_crafted = total_items_crafted + 1 WHERE user_id = ?', [userId]);
    incrementDailyQuestStat(userId, 'craft_count', 1);

    // Achievement checks
    const totalCrafted = db.get('SELECT total_items_crafted FROM game_players WHERE user_id = ?', [userId])?.total_items_crafted || 0;
    checkAchievement(userId, 'first_craft', totalCrafted >= 1);
    checkAchievement(userId, 'craft_25', totalCrafted >= 25);
    checkAchievement(userId, 'craft_100', totalCrafted >= 100);
    if (recipe.skill === 'smithing' && recipe.station === 'furnace') checkAchievement(userId, 'smelt_first', true);

    // Smithing recipes award smithing XP, others award crafting XP
    const xpSkill = recipe.skill === 'smithing' ? 'smithing' : 'crafting';
    return { success: true, output: { id: recipe.output, ...ITEMS[recipe.output] }, qty: recipe.qty, xp: addXp(userId, xpSkill, recipe.xp) };
}

function rollRecipeUnlock(userId) {
    const all = Object.entries(RECIPES).filter(([_, r]) => r.rarity !== 'Common');
    const have = new Set(db.all('SELECT recipe_id FROM game_recipes WHERE user_id = ?', [userId]).map(r => r.recipe_id));
    const avail = all.filter(([id]) => !have.has(id));
    if (!avail.length || Math.random() > 0.05) return null;
    const weights = { Uncommon: 40, Rare: 25, Epic: 10, Legendary: 3 };
    const table = avail.map(([id, r]) => ({ id, weight: weights[r.rarity] || 10 }));
    const recipeId = rollLoot(table);
    db.run('INSERT OR IGNORE INTO game_recipes (user_id, recipe_id) VALUES (?, ?)', [userId, recipeId]);
    return { id: recipeId, ...RECIPES[recipeId] };
}

// ══════════════════════════════════════════════════════════════
//  COMBAT (Open-world PvP)
// ══════════════════════════════════════════════════════════════

function attackPlayer(attackerId, targetId) {
    const atk = getPlayer(attackerId);
    const def = getPlayer(targetId);
    if (!def) return { error: 'Target not found.' };

    // Weapon stats affect range
    const weaponInfo = getWeaponInfo(atk.equip_weapon);
    const attackRange = TILE * 3 * (weaponInfo.range || 1.0);
    const dist = Math.sqrt((atk.x - def.x) ** 2 + (atk.y - def.y) ** 2);
    if (dist > attackRange) return { error: 'Too far!' };

    const aTile = { x: Math.floor(atk.x / TILE), y: Math.floor(atk.y / TILE) };
    const dTile = { x: Math.floor(def.x / TILE), y: Math.floor(def.y / TILE) };
    if (isInSafeZone(aTile.x, aTile.y) || isInSafeZone(dTile.x, dTile.y)) return { error: 'No PvP in Town!' };

    // Check dodge i-frames
    if (isInvulnerable(targetId)) return { success: true, dodged: true, dmg: 0, targetHp: def.hp, targetMaxHp: def.max_hp, killed: false };

    // Combo system
    registerHit(attackerId);
    const combo = getComboMultiplier(attackerId);

    const isCrit = Math.random() < 0.15;
    let dmg = Math.max(1, Math.round(atk.attack * (0.8 + Math.random() * 0.4) - def.defense * 0.3));
    if (isCrit) dmg = Math.round(dmg * 1.5);
    dmg = Math.round(dmg * combo.mult);

    const newHp = Math.max(0, def.hp - dmg);
    db.run('UPDATE game_players SET hp = ? WHERE user_id = ?', [newHp, targetId]);

    const result = {
        success: true, dmg, isCrit, targetHp: newHp, targetMaxHp: def.max_hp, killed: false,
        combo: combo.count, comboMult: combo.mult,
        weaponSpeed: weaponInfo.speed,
    };

    if (newHp <= 0) {
        result.killed = true;
        result.deathData = handleDeath(targetId, attackerId);
        result.xp = addXp(attackerId, 'combat', 30 + atk.combat_level * 3);
        ensureBattleStats(attackerId);
        ensureBattleStats(targetId);
        db.run('UPDATE game_battle_stats SET battles_won = battles_won + 1, kill_streak = kill_streak + 1, best_streak = MAX(best_streak, kill_streak + 1), kills = kills + 1 WHERE user_id = ?', [attackerId]);
        db.run('UPDATE game_battle_stats SET battles_lost = battles_lost + 1, kill_streak = 0, deaths = deaths + 1 WHERE user_id = ?', [targetId]);
        comboTrackers.delete(attackerId);
        // PvP achievements
        checkAchievement(attackerId, 'pvp_first', true);
        const streak = db.get('SELECT kill_streak FROM game_battle_stats WHERE user_id = ?', [attackerId])?.kill_streak || 0;
        checkAchievement(attackerId, 'kill_streak_5', streak >= 5);
    }
    // Combo achievement
    if (combo.count >= 5) checkAchievement(attackerId, 'combo_master', true);
    return result;
}

function handleDeath(userId, killerId) {
    const inv = getInventory(userId);
    const dropped = [];
    const p = getPlayer(userId);
    const deathX = p.x, deathY = p.y;

    for (const item of inv) {
        if (item.item_id.startsWith('fx_') || item.item_id.startsWith('px_')) continue; // Keep cosmetics
        const dropQty = Math.floor(item.quantity / 2);
        if (dropQty > 0) {
            removeItem(userId, item.item_id, dropQty);
            // Scatter items as ground drops around the death position
            const angle = Math.random() * Math.PI * 2;
            const dist = 20 + Math.random() * 60;
            const gx = deathX + Math.cos(angle) * dist;
            const gy = deathY + Math.sin(angle) * dist;
            const gid = dropGroundItem(item.item_id, dropQty, gx, gy, userId);
            dropped.push({
                groundId: gid, id: item.item_id, qty: dropQty,
                name: item.name, emoji: item.emoji,
                x: gx, y: gy,
            });
        }
    }
    const spawn = db.get('SELECT sleeping_bag_x, sleeping_bag_y FROM game_players WHERE user_id = ?', [userId]);
    let sx = OUTPOST_X * TILE + TILE / 2, sy = OUTPOST_Y * TILE + TILE / 2;
    if (spawn?.sleeping_bag_x && spawn?.sleeping_bag_y) { sx = spawn.sleeping_bag_x; sy = spawn.sleeping_bag_y; }
    db.run('UPDATE game_players SET hp = max_hp, stamina = max_stamina, x = ?, y = ?, total_deaths = total_deaths + 1 WHERE user_id = ?', [sx, sy, userId]);
    addXp(userId, 'combat', 5);
    // Achievement: die 10 times
    const deathP = getPlayer(userId);
    if (deathP) checkAchievement(userId, 'die_10', deathP.total_deaths >= 10);
    return { dropped, spawnX: sx, spawnY: sy, deathX, deathY };
}

function ensureBattleStats(userId) { db.run('INSERT OR IGNORE INTO game_battle_stats (user_id) VALUES (?)', [userId]); }

function getBattleStats(userId) {
    ensureBattleStats(userId);
    return db.get('SELECT * FROM game_battle_stats WHERE user_id = ?', [userId]);
}

// ══════════════════════════════════════════════════════════════
//  DUNGEON (PvE)
// ══════════════════════════════════════════════════════════════

function enterDungeon(userId) {
    const p = getPlayer(userId);
    if (p.combat_level < 5) return { error: 'Need Combat Lv 5.' };
    if (!removeItem(userId, 'dungeon_key', 1)) return { error: 'Need a Dungeon Key!' };
    const maxIdx = Math.min(MONSTERS.length - 1, Math.floor(p.combat_level / 5));
    const monster = { ...MONSTERS[Math.floor(Math.random() * (maxIdx + 1))] };
    const scale = 1 + (p.combat_level - 1) * 0.05;
    monster.hp = Math.round(monster.hp * scale);
    monster.atk = Math.round(monster.atk * scale);
    // Achievement: enter a dungeon
    checkAchievement(userId, 'dungeon_enter', true);
    return { success: true, monster, playerHp: p.hp, playerAtk: p.attack, playerDef: p.defense };
}

function fightMonster(userId, monster) {
    const p = getPlayer(userId);
    let playerHp = p.hp, monsterHp = monster.hp;
    const log = [];
    let round = 0;
    while (playerHp > 0 && monsterHp > 0 && round < 20) {
        round++;
        const pDmg = Math.max(1, Math.round(p.attack * (0.8 + Math.random() * 0.4) - (monster.def || 0) * 0.3));
        monsterHp -= pDmg;
        log.push({ type: 'player_attack', dmg: pDmg, monsterHp: Math.max(0, monsterHp) });
        if (monsterHp <= 0) break;
        const mDmg = Math.max(1, Math.round(monster.atk * (0.8 + Math.random() * 0.4) - p.defense * 0.3));
        playerHp -= mDmg;
        log.push({ type: 'monster_attack', dmg: mDmg, playerHp: Math.max(0, playerHp) });
    }
    db.run('UPDATE game_players SET hp = ? WHERE user_id = ?', [Math.max(0, playerHp), userId]);
    const won = monsterHp <= 0;
    if (won) {
        const xp = addXp(userId, 'combat', monster.xp);
        db.addOpenCoins(userId, monster.gold);
        db.run('UPDATE game_players SET total_monsters_killed = total_monsters_killed + 1, total_dungeon_wins = total_dungeon_wins + 1 WHERE user_id = ?', [userId]);
        let lootDrop = null;
        if (monster.loot?.length) {
            const lootId = rollLoot(monster.loot.map(l => ({ id: l.id, weight: l.w })));
            addItem(userId, lootId, 1);
            lootDrop = { id: lootId, ...ITEMS[lootId] };
        }
        // Achievement: dungeon wins
        const dwP = getPlayer(userId);
        if (dwP) checkAchievement(userId, 'dungeon_wins_10', dwP.total_dungeon_wins >= 10);
        return { success: true, won: true, log, xp, gold: monster.gold, loot: lootDrop };
    }
    db.run('UPDATE game_players SET total_deaths = total_deaths + 1, hp = max_hp WHERE user_id = ?', [userId]);
    addXp(userId, 'combat', Math.round(monster.xp * 0.2));
    return { success: true, won: false, log };
}

// ══════════════════════════════════════════════════════════════
//  EQUIPMENT
// ══════════════════════════════════════════════════════════════

const EQUIPMENT_SLOTS = { rods: 'equip_rod', pickaxes: 'equip_pickaxe', axes: 'equip_axe', hats: 'equip_hat', weapons: 'equip_weapon', armor: 'equip_armor' };

/** Check if newItemId is a better equipment than currentItemId in the given category */
function isBetterEquipment(currentItemId, newItemId, category) {
    if (!currentItemId) return true;
    const curItem = ITEMS[currentItemId];
    const newItem = ITEMS[newItemId];
    if (!curItem || !newItem) return false;
    // For tools (pickaxes/axes/rods), compare by buyCost as tier proxy
    if (['pickaxes', 'axes', 'rods'].includes(category)) {
        const tierMaps = { pickaxes: PICK_TIERS, axes: AXE_TIERS };
        const tierMap = tierMaps[category];
        if (tierMap) {
            const curTier = tierMap[currentItemId]?.tier ?? -1;
            const newTier = tierMap[newItemId]?.tier ?? -1;
            return newTier > curTier;
        }
        return (newItem.buyCost || 0) > (curItem.buyCost || 0);
    }
    // For weapons/armor, compare by stats
    if (category === 'weapons') return (WEAPON_STATS[newItemId]?.atk || 0) > (WEAPON_STATS[currentItemId]?.atk || 0);
    if (category === 'armor') return (ARMOR_STATS[newItemId]?.def || 0) > (ARMOR_STATS[currentItemId]?.def || 0);
    return false;
}

function equipItem(userId, itemId) {
    const item = ITEMS[itemId];
    if (!item) return { error: 'Unknown item.' };
    if (!hasItem(userId, itemId, 1)) return { error: 'You don\'t have that.' };
    const slot = EQUIPMENT_SLOTS[item.category];
    if (!slot) return { error: 'Can\'t equip that.' };

    // Level requirement check (RuneScape-style)
    const skillName = EQUIP_SKILL_MAP[item.category];
    if (skillName && item.levelReq) {
        const p = getPlayer(userId);
        const playerLevel = xpToLevel(p[`${skillName}_xp`]);
        if (playerLevel < item.levelReq) {
            return { error: `Need ${skillName.charAt(0).toUpperCase() + skillName.slice(1)} level ${item.levelReq} to equip! (You're level ${playerLevel})` };
        }
    }

    db.run(`UPDATE game_players SET ${slot} = ? WHERE user_id = ?`, [itemId, userId]);
    recalcCombatStats(userId);
    // Achievement: first hat
    if (item.category === 'hats') checkAchievement(userId, 'first_hat', true);
    return { success: true, slot: item.category, item: { id: itemId, ...item } };
}

function unequipItem(userId, slotCategory) {
    const SLOT_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
    const col = SLOT_MAP[slotCategory];
    if (!col) return { error: 'Invalid slot.' };
    const p = getPlayer(userId);
    if (!p[col]) return { error: 'Nothing equipped there.' };
    const removedId = p[col];
    db.run(`UPDATE game_players SET ${col} = NULL WHERE user_id = ?`, [userId]);
    recalcCombatStats(userId);
    const item = ITEMS[removedId];
    return { success: true, slot: slotCategory, item: item ? { id: removedId, ...item } : { id: removedId } };
}

function recalcCombatStats(userId) {
    const p = db.get('SELECT equip_weapon, equip_armor FROM game_players WHERE user_id = ?', [userId]);
    let atk = 10 + (WEAPON_STATS[p.equip_weapon]?.atk || 0);
    let def = 5 + (ARMOR_STATS[p.equip_armor]?.def || 0);
    // Apply food buffs
    const buff = getActiveFoodBuff(userId);
    if (buff) { atk += (buff.atk || 0); def += (buff.def || 0); }
    db.run('UPDATE game_players SET attack = ?, defense = ? WHERE user_id = ?', [atk, def, userId]);
}

// ══════════════════════════════════════════════════════════════
//  DODGE ROLL
// ══════════════════════════════════════════════════════════════

function dodgeRoll(userId, dx, dy) {
    const p = getPlayer(userId);
    const sta = db.get('SELECT stamina FROM game_players WHERE user_id = ?', [userId])?.stamina || 0;
    // Agility reduces dodge cost (base 20, min 10)
    const bonuses = getAgilityBonuses(p.agility_level);
    const dodgeCost = Math.max(10, 20 - bonuses.dodgeCostReduct);
    if (sta < dodgeCost) return { error: `Not enough stamina to dodge! (Need ${dodgeCost})` };
    // Check cooldown (1.5s)
    const existing = dodgeIframes.get(userId);
    if (existing && Date.now() < existing + 1000) return { error: 'Dodge on cooldown!' };
    db.run('UPDATE game_players SET stamina = stamina - ? WHERE user_id = ?', [dodgeCost, userId]);
    // Grant 400ms invulnerability
    dodgeIframes.set(userId, Date.now() + 400);
    // Calculate dodge destination (3 tiles + agility bonus)
    const bonusDist = Math.floor(p.agility_level * 0.05 * TILE);
    const dist = TILE * 3 + bonusDist;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const newX = Math.max(TILE, Math.min((MAP_W - 1) * TILE, p.x + (dx / len) * dist));
    const newY = Math.max(TILE, Math.min((MAP_H - 1) * TILE, p.y + (dy / len) * dist));
    updatePlayerPosition(userId, newX, newY);
    // Grant agility XP for dodging
    const agilXp = addXp(userId, 'agility', 15);
    return { success: true, stamina: sta - dodgeCost, x: newX, y: newY, agilityXp: agilXp };
}

function isInvulnerable(userId) {
    const t = dodgeIframes.get(userId);
    if (!t) return false;
    if (Date.now() < t) return true;
    dodgeIframes.delete(userId);
    return false;
}

// ══════════════════════════════════════════════════════════════
//  COMBO SYSTEM
// ══════════════════════════════════════════════════════════════

function getComboMultiplier(userId) {
    const c = comboTrackers.get(userId);
    if (!c) return { mult: 1.0, count: 0 };
    if (Date.now() - c.lastHitTime > COMBO_WINDOW) {
        comboTrackers.delete(userId);
        return { mult: 1.0, count: 0 };
    }
    const idx = Math.min(c.count, COMBO_MULTIPLIERS.length - 1);
    return { mult: COMBO_MULTIPLIERS[idx], count: c.count };
}

function registerHit(userId) {
    const c = comboTrackers.get(userId);
    const now = Date.now();
    if (c && now - c.lastHitTime < COMBO_WINDOW) {
        c.count++;
        c.lastHitTime = now;
    } else {
        comboTrackers.set(userId, { count: 1, lastHitTime: now });
    }
}

// ══════════════════════════════════════════════════════════════
//  SPRINT STAMINA
// ══════════════════════════════════════════════════════════════

function drainSprintStamina(userId) {
    // Called every ~500ms while sprinting
    sprintingPlayers.add(userId); // Mark as sprinting for regen tick
    const buff = getActiveFoodBuff(userId);
    if (buff?.sprint_free) {
        // Still grant agility XP even with free sprint
        addXp(userId, 'agility', 1);
        return { ok: true };
    }
    const pd = getPlayer(userId);
    const p = db.get('SELECT stamina FROM game_players WHERE user_id = ?', [userId]);
    if (!p || p.stamina <= 0) return { ok: false, stamina: 0 };
    // Agility reduces sprint drain (base 1, reduced by sprintDrainMult)
    const bonuses = getAgilityBonuses(pd.agility_level);
    // Apply drain reduction: at high agility, skip some drain ticks
    if (bonuses.sprintDrainMult < 1.0 && Math.random() > bonuses.sprintDrainMult) {
        // Saved by agility — no drain this tick
        addXp(userId, 'agility', 1);
        return { ok: true, stamina: p.stamina };
    }
    db.run('UPDATE game_players SET stamina = MAX(0, stamina - 1) WHERE user_id = ?', [userId]);
    // Grant agility XP for sprinting
    addXp(userId, 'agility', 1);
    return { ok: true, stamina: p.stamina - 1 };
}

// ══════════════════════════════════════════════════════════════
//  FOOD / BUFF SYSTEM
// ══════════════════════════════════════════════════════════════

function eatFood(userId, itemId) {
    const effect = FOOD_EFFECTS[itemId];
    if (!effect) return { error: 'Not food.' };
    if (!removeItem(userId, itemId, 1)) return { error: 'Don\'t have it.' };
    const result = { success: true, food: itemId, effects: [] };
    // Instant HP heal
    if (effect.hp) {
        db.run('UPDATE game_players SET hp = MIN(max_hp, hp + ?) WHERE user_id = ?', [effect.hp, userId]);
        result.effects.push({ type: 'heal', amount: effect.hp });
    }
    // Instant stamina restore
    if (effect.stamina) {
        db.run('UPDATE game_players SET stamina = MIN(max_stamina, stamina + ?) WHERE user_id = ?', [effect.stamina, userId]);
        result.effects.push({ type: 'stamina', amount: effect.stamina });
    }
    // Timed buff
    if (effect.buff) {
        const buff = { ...effect.buff, expiresAt: Date.now() + effect.buff.duration };
        foodBuffs.set(userId, buff);
        result.effects.push({ type: 'buff', buff: { ...effect.buff } });
        result.buffDuration = effect.buff.duration;
        // Recalc combat stats if buff has ATK/DEF
        if (effect.buff.atk || effect.buff.def) recalcCombatStats(userId);
    }
    // XP for cooking skill
    addXp(userId, 'crafting', 5);
    return result;
}

function getActiveFoodBuff(userId) {
    const buff = foodBuffs.get(userId);
    if (!buff) return null;
    if (Date.now() > buff.expiresAt) {
        foodBuffs.delete(userId);
        recalcCombatStats(userId); // Remove buff stats
        return null;
    }
    return buff;
}

function getWeaponInfo(weaponId) {
    return WEAPON_STATS[weaponId] || WEAPON_STATS.weapon_fist;
}

// ══════════════════════════════════════════════════════════════
//  COSMETICS
// ══════════════════════════════════════════════════════════════

function equipCosmetic(userId, itemId) {
    const item = ITEMS[itemId];
    if (!item || !hasItem(userId, itemId, 1)) return { error: 'Don\'t have it.' };
    if (item.category === 'name_effects') { db.run('UPDATE game_players SET name_effect = ? WHERE user_id = ?', [itemId, userId]); return { success: true, type: 'name_effect' }; }
    if (item.category === 'particles') { db.run('UPDATE game_players SET particle_effect = ? WHERE user_id = ?', [itemId, userId]); return { success: true, type: 'particle_effect' }; }
    return { error: 'Not cosmetic.' };
}

function unequipCosmetic(userId, type) {
    if (type === 'name_effect') db.run('UPDATE game_players SET name_effect = NULL WHERE user_id = ?', [userId]);
    else if (type === 'particle_effect') db.run('UPDATE game_players SET particle_effect = NULL WHERE user_id = ?', [userId]);
    return { success: true };
}

// ══════════════════════════════════════════════════════════════
//  CONSUMABLES / EFFECTS
// ══════════════════════════════════════════════════════════════

function useConsumable(userId, itemId) {
    if (!removeItem(userId, itemId, 1)) return { error: 'Don\'t have it.' };
    const effects = {
        craft_elixir: { type: 'coin_boost', duration: 600000, data: { multiplier: 2 } },
        craft_xp_potion: { type: 'xp_boost', duration: 600000, data: { multiplier: 2 } },
        craft_loot_magnet: { type: 'loot_magnet', charges: 5 },
        supp_stamina: { type: 'instant', effect: 'stamina', amount: 50 },
        potion_health: { type: 'instant', effect: 'hp', amount: 30 },
        potion_health_big: { type: 'instant', effect: 'hp', amount: 75 },
        potion_stamina: { type: 'instant', effect: 'stamina', amount: 30 },
    };
    const eff = effects[itemId];
    if (!eff) return { error: 'Not consumable.' };
    if (eff.type === 'instant') {
        if (eff.effect === 'hp') db.run('UPDATE game_players SET hp = MIN(max_hp, hp + ?) WHERE user_id = ?', [eff.amount, userId]);
        else db.run('UPDATE game_players SET stamina = MIN(max_stamina, stamina + ?) WHERE user_id = ?', [eff.amount, userId]);
        return { success: true, instant: true, effect: eff.effect, amount: eff.amount };
    }
    const expiresAt = eff.duration ? new Date(Date.now() + eff.duration).toISOString().replace('T', ' ').slice(0, 19) : null;
    db.run('INSERT INTO game_effects (user_id, effect_type, effect_id, expires_at, charges, data) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, eff.type, itemId, expiresAt, eff.charges || null, JSON.stringify(eff.data || {})]);
    return { success: true, effectType: eff.type, duration: eff.duration, charges: eff.charges };
}

function getActiveEffects(userId) {
    db.run("DELETE FROM game_effects WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP AND user_id = ?", [userId]);
    db.run("DELETE FROM game_effects WHERE charges IS NOT NULL AND charges <= 0 AND user_id = ?", [userId]);
    return db.all('SELECT * FROM game_effects WHERE user_id = ?', [userId]);
}

// ══════════════════════════════════════════════════════════════
//  LEADERBOARDS
// ══════════════════════════════════════════════════════════════

function getLeaderboard(boardType, limit = 20) {
    const cols = {
        mining: 'mining_xp', fishing: 'fishing_xp', woodcut: 'woodcut_xp',
        farming: 'farming_xp', combat: 'combat_xp', crafting: 'crafting_xp',
        smithing: 'smithing_xp', agility: 'COALESCE(agility_xp, 0)',
        total_level: 'mining_xp + fishing_xp + woodcut_xp + farming_xp + combat_xp + crafting_xp + COALESCE(smithing_xp, 0) + COALESCE(agility_xp, 0)',
        kills: 'total_monsters_killed', buildings: 'structures_built',
    };
    const col = cols[boardType];
    if (!col) return [];
    return db.all(`SELECT gp.user_id, gp.display_name, u.username, ${col} as score, gp.name_effect, gp.particle_effect
        FROM game_players gp JOIN users u ON gp.user_id = u.id ORDER BY ${col} DESC LIMIT ?`, [limit]);
}

// ══════════════════════════════════════════════════════════════
//  MULTIPLAYER STATE
// ══════════════════════════════════════════════════════════════

const livePlayers = new Map();

function updateLivePlayer(userId, data) {
    livePlayers.set(userId, { ...data, userId, lastUpdate: Date.now() });
}

function removeLivePlayer(userId) { livePlayers.delete(userId); }

function getLivePlayers() {
    const now = Date.now();
    const result = {};
    for (const [uid, p] of livePlayers) {
        if (now - p.lastUpdate > 30000) { livePlayers.delete(uid); continue; }
        result[uid] = p;
    }
    return result;
}

// ══════════════════════════════════════════════════════════════
//  WORLD MOBS — In-memory PvE system
// ══════════════════════════════════════════════════════════════

const liveMobs = new Map();   // mobId → mob object
let mobIdCounter = 0;
const MOB_LEASH       = 8 * TILE;
const MOB_ATTACK_RANGE = 1.5 * TILE;
const MOB_ATTACK_CD   = 2000;       // ms between mob attacks
const MOB_MAX_NEARBY  = 8;          // max mobs within 10 tiles of a player

/** Spawn mobs near live players. Called every few seconds. */
function spawnMobs() {
    const players = getLivePlayers();
    for (const [uid, p] of Object.entries(players)) {
        const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
        if (isInSafeZone(ptx, pty)) continue;
        // Count existing mobs nearby
        let nearby = 0;
        for (const mob of liveMobs.values()) {
            if (Math.abs(mob.x - p.x) + Math.abs(mob.y - p.y) < 10 * TILE) nearby++;
        }
        if (nearby >= MOB_MAX_NEARBY) continue;

        const angle = Math.random() * Math.PI * 2;
        const dist = (5 + Math.random() * 6) * TILE;
        const mx = p.x + Math.cos(angle) * dist;
        const my = p.y + Math.sin(angle) * dist;
        const mtx = Math.floor(mx / TILE), mty = Math.floor(my / TILE);
        if (mtx < 1 || mtx >= MAP_W - 1 || mty < 1 || mty >= MAP_H - 1) continue;

        const biome = getBiomeAt(mtx, mty, worldSeed);
        if (biome === 'water' || biome === 'outpost') continue;

        const tier = getDifficultyTier(mtx, mty);
        const eligible = Object.entries(MOB_TYPES).filter(([_, m]) =>
            m.biomes.includes(biome) && m.minTier <= tier
        );
        if (!eligible.length) continue;

        const [typeName, def] = eligible[Math.floor(Math.random() * eligible.length)];
        const scale = 1 + tier * 0.15;
        const id = ++mobIdCounter;
        liveMobs.set(id, {
            id, type: typeName, name: def.name, emoji: def.emoji,
            x: mx, y: my, spawnX: mx, spawnY: my,
            hp: Math.round(def.hp * scale), maxHp: Math.round(def.hp * scale),
            atk: Math.round(def.atk * scale), def: Math.round(def.def * scale),
            speed: def.speed, aggroRange: def.aggroRange * TILE,
            state: 'idle', targetUserId: null, lastAttack: 0,
            patrolAngle: Math.random() * Math.PI * 2,
            xp: def.xp, gold: Math.round(def.gold * scale), loot: def.loot,
            _pendingAttack: null, _pendingKill: null,
        });
    }
}

/** Run one AI tick for every live mob. Returns arrays of pending attacks/kills for broadcast. */
function mobTick() {
    const now = Date.now();
    const players = getLivePlayers();
    const toRemove = [];
    const attacks = [];   // { mobId, targetId, dmg, newHp, maxHp }
    const kills = [];     // { mobId, targetId, deathData }

    for (const [id, mob] of liveMobs) {
        // Despawn if far from all players
        let nearDist = Infinity, nearP = null;
        for (const [uid, p] of Object.entries(players)) {
            const d = Math.abs(mob.x - p.x) + Math.abs(mob.y - p.y);
            if (d < nearDist) { nearDist = d; nearP = { uid, ...p }; }
        }
        if (nearDist > 16 * TILE) { toRemove.push(id); continue; }

        const spd = mob.speed * 1.6;  // pixels per tick

        switch (mob.state) {
            case 'idle': {
                if (nearP && nearDist < mob.aggroRange) {
                    const ptx = Math.floor(nearP.x / TILE), pty = Math.floor(nearP.y / TILE);
                    if (!isInSafeZone(ptx, pty)) { mob.state = 'chase'; mob.targetUserId = nearP.uid; break; }
                }
                if (Math.random() < 0.02) { mob.state = 'patrol'; mob.patrolAngle = Math.random() * Math.PI * 2; }
                break;
            }
            case 'patrol': {
                mob.x += Math.cos(mob.patrolAngle) * spd * 0.5;
                mob.y += Math.sin(mob.patrolAngle) * spd * 0.5;
                if (Math.random() < 0.03) mob.state = 'idle';
                if (nearP && nearDist < mob.aggroRange) {
                    const ptx = Math.floor(nearP.x / TILE), pty = Math.floor(nearP.y / TILE);
                    if (!isInSafeZone(ptx, pty)) { mob.state = 'chase'; mob.targetUserId = nearP.uid; break; }
                }
                const ds = Math.sqrt((mob.x - mob.spawnX) ** 2 + (mob.y - mob.spawnY) ** 2);
                if (ds > MOB_LEASH) mob.state = 'returning';
                break;
            }
            case 'chase': {
                const tgt = players[mob.targetUserId];
                if (!tgt) { mob.state = 'idle'; mob.targetUserId = null; break; }
                const dx = tgt.x - mob.x, dy = tgt.y - mob.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                const ttx = Math.floor(tgt.x / TILE), tty = Math.floor(tgt.y / TILE);
                if (isInSafeZone(ttx, tty) || d > mob.aggroRange * 1.6) {
                    mob.state = 'returning'; mob.targetUserId = null; break;
                }
                if (d > MOB_ATTACK_RANGE) {
                    mob.x += (dx / d) * spd;
                    mob.y += (dy / d) * spd;
                } else if (now - mob.lastAttack >= MOB_ATTACK_CD) {
                    mob.lastAttack = now;
                    const targetUid = parseInt(mob.targetUserId);
                    // Dodge i-frame check
                    if (isInvulnerable(targetUid)) {
                        attacks.push({ mobId: id, mobName: mob.name, targetId: mob.targetUserId, dmg: 0, dodged: true, newHp: -1, maxHp: -1 });
                    } else {
                        const pData = getPlayer(targetUid);
                        if (pData) {
                            const dmg = Math.max(1, Math.round(mob.atk * (0.8 + Math.random() * 0.4) - pData.defense * 0.3));
                            const newHp = Math.max(0, pData.hp - dmg);
                            db.run('UPDATE game_players SET hp = ? WHERE user_id = ?', [newHp, targetUid]);
                            attacks.push({ mobId: id, mobName: mob.name, targetId: mob.targetUserId, dmg, newHp, maxHp: pData.max_hp });
                            if (newHp <= 0) {
                                const deathData = handleDeath(targetUid, null);
                                kills.push({ mobId: id, mobName: mob.name, targetId: mob.targetUserId, deathData });
                                mob.state = 'idle'; mob.targetUserId = null;
                            }
                        }
                    }
                }
                const ds = Math.sqrt((mob.x - mob.spawnX) ** 2 + (mob.y - mob.spawnY) ** 2);
                if (ds > MOB_LEASH) { mob.state = 'returning'; mob.targetUserId = null; }
                break;
            }
            case 'returning': {
                const dx = mob.spawnX - mob.x, dy = mob.spawnY - mob.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < TILE) { mob.state = 'idle'; mob.hp = mob.maxHp; }
                else { mob.x += (dx / d) * spd * 1.4; mob.y += (dy / d) * spd * 1.4; }
                break;
            }
        }

        // Clamp to world bounds
        mob.x = Math.max(TILE, Math.min((MAP_W - 1) * TILE, mob.x));
        mob.y = Math.max(TILE, Math.min((MAP_H - 1) * TILE, mob.y));
    }
    for (const mid of toRemove) liveMobs.delete(mid);
    return { attacks, kills };
}

/** Player attacks a world mob */
function attackMob(userId, mobId) {
    const mob = liveMobs.get(mobId);
    if (!mob) return { error: 'Target not found.' };
    const p = getPlayer(userId);
    if (!p) return { error: 'Player not found.' };

    // Weapon range affects attack distance
    const weaponInfo = getWeaponInfo(p.equip_weapon);
    const attackRange = TILE * 3 * (weaponInfo.range || 1.0);
    const dist = Math.sqrt((p.x - mob.x) ** 2 + (p.y - mob.y) ** 2);
    if (dist > attackRange) return { error: 'Too far!' };

    // Combo system
    registerHit(userId);
    const combo = getComboMultiplier(userId);

    const isCrit = Math.random() < 0.15;
    let dmg = Math.max(1, Math.round(p.attack * (0.8 + Math.random() * 0.4) - mob.def * 0.3));
    if (isCrit) dmg = Math.round(dmg * 1.5);
    dmg = Math.round(dmg * combo.mult);
    mob.hp -= dmg;

    // Aggro onto attacker
    if (mob.state !== 'chase' || mob.targetUserId !== String(userId)) {
        mob.state = 'chase';
        mob.targetUserId = String(userId);
    }

    if (mob.hp <= 0) {
        // XP multiplier from food buff
        const buff = getActiveFoodBuff(userId);
        const xpMult = buff?.xp_mult || 1;
        const xpResult = addXp(userId, 'combat', Math.round(mob.xp * xpMult));
        db.addOpenCoins(userId, mob.gold);
        db.run('UPDATE game_players SET total_monsters_killed = total_monsters_killed + 1 WHERE user_id = ?', [userId]);
        incrementDailyQuestStat(userId, 'mob_kills', 1);
        let lootDrop = null;
        if (mob.loot?.length) {
            const lootId = rollLoot(mob.loot.map(l => ({ id: l.id, weight: l.w })));
            if (lootId) { addItem(userId, lootId, 1); lootDrop = { id: lootId, ...(ITEMS[lootId] || { name: lootId }) }; }
        }
        liveMobs.delete(mobId);
        comboTrackers.delete(userId);
        // Achievement: mob kills
        const mkP = getPlayer(userId);
        if (mkP) {
            checkAchievement(userId, 'first_blood', true);
            checkAchievement(userId, 'mob_slayer_10', mkP.total_monsters_killed >= 10);
            checkAchievement(userId, 'mob_slayer_50', mkP.total_monsters_killed >= 50);
            checkAchievement(userId, 'mob_slayer_100', mkP.total_monsters_killed >= 100);
            if (mob.type === 'dragon') checkAchievement(userId, 'dragon_slayer', true);
        }
        return {
            success: true, dmg, isCrit, killed: true, mobName: mob.name, mobEmoji: mob.emoji,
            xp: xpResult, gold: mob.gold, loot: lootDrop, mobX: mob.x, mobY: mob.y,
            combo: combo.count, comboMult: combo.mult, weaponSpeed: weaponInfo.speed,
        };
    }
    return {
        success: true, dmg, isCrit, killed: false,
        mobHp: mob.hp, mobMaxHp: mob.maxHp, mobX: mob.x, mobY: mob.y,
        combo: combo.count, comboMult: combo.mult, weaponSpeed: weaponInfo.speed,
    };
}

/** Serialise live mobs for state broadcast */
function getMobStates() {
    const r = {};
    for (const [id, m] of liveMobs) {
        r[id] = { id: m.id, type: m.type, name: m.name, emoji: m.emoji, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, state: m.state };
    }
    return r;
}

/** Passive health regen for out-of-combat players (call from tick every ~3s) */
function regenHealth() {
    const players = getLivePlayers();
    for (const [uid, p] of Object.entries(players)) {
        const pd = getPlayer(parseInt(uid));
        if (!pd || pd.hp >= pd.max_hp) continue;
        // Check if any mob is targeting this player
        let inCombat = false;
        for (const mob of liveMobs.values()) {
            if (mob.targetUserId === uid && mob.state === 'chase') { inCombat = true; break; }
        }
        if (!inCombat) {
            // Food buff hp_regen bonus
            const buff = getActiveFoodBuff(parseInt(uid));
            const basePct = 0.03 + (buff?.hp_regen || 0);
            const regen = Math.max(1, Math.round(pd.max_hp * basePct));
            const newHp = Math.min(pd.max_hp, pd.hp + regen);
            if (newHp !== pd.hp) db.run('UPDATE game_players SET hp = ? WHERE user_id = ?', [newHp, parseInt(uid)]);
        }
    }
}

/**
 * Track player movement for agility XP (swimming, distance).
 * Called from _handleMove in game-server.js.
 */
function trackMovement(userId, x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const biome = getBiomeAt(tx, ty, worldSeed);

    // Swimming grants bonus agility XP
    if (biome === 'water') {
        if (!swimmingPlayers.has(userId)) {
            swimmingPlayers.add(userId);
        }
        // 2 XP per movement tick in water
        addXp(userId, 'agility', 2);
    } else {
        swimmingPlayers.delete(userId);
    }

    // Distance-based agility XP: 1 XP per ~10 tiles traveled
    const prev = playerDistAccum.get(userId) || { x, y, accum: 0 };
    const dist = Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2) / TILE;
    prev.accum += dist;
    prev.x = x; prev.y = y;
    if (prev.accum >= 10) {
        const chunks = Math.floor(prev.accum / 10);
        addXp(userId, 'agility', chunks);
        prev.accum -= chunks * 10;
        // Update total tiles traveled for achievement tracking
        db.run('UPDATE game_players SET total_tiles_traveled = total_tiles_traveled + ? WHERE user_id = ?', [chunks * 10, userId]);
        incrementDailyQuestStat(userId, 'tiles_traveled', chunks * 10);
        const ttP = getPlayer(userId);
        if (ttP) {
            checkAchievement(userId, 'explorer_1k', ttP.total_tiles_traveled >= 1000);
            checkAchievement(userId, 'explorer_10k', ttP.total_tiles_traveled >= 10000);
        }
    }
    playerDistAccum.set(userId, prev);
}

/**
 * Get agility stats for a player (for UI/API).
 */
function getAgilityStats(userId) {
    const p = getPlayer(userId);
    const bonuses = getAgilityBonuses(p.agility_level);
    return {
        level: p.agility_level,
        xp: p.agility_xp,
        nextLevelXp: p.agility_level * p.agility_level * 25,
        bonuses,
    };
}

module.exports = {
    initGameDb, getWorldSeed: () => worldSeed,
    ITEMS, RECIPES, STRUCTURES, RARITY_COLORS, BIOME_COLORS,
    MAP_W, MAP_H, TILE, OUTPOST_X, OUTPOST_Y, OUTPOST_RADIUS,
    WEAPON_STATS, ARMOR_STATS, EQUIP_SKILL_MAP, FOOD_EFFECTS,
    xpToLevel, levelToXp,
    // Player
    getPlayer, updatePlayerPosition, addXp, regenStamina,
    // Inventory
    getInventory, getItemCount, addItem, removeItem, hasItem,
    // Bank
    getBank, bankDeposit, bankWithdraw, isNearBankNPC,
    // Shop
    getShopItems, buyItem, sellItem, buyWithCoins, getCoinShopItems,
    // NPCs
    isNearNPC, isNearAnyShopNPC, getNearestNPC, getShopItemsForNPC, getSellableItemsForNPC,
    // Gathering
    gather, getDepletedNodes, isNodeDepleted, depleteNode,
    // Fishing
    fish, useSonar, getFishCollection,
    // Building
    placeStructure, destroyStructure, getStructuresInArea, getAllStructures,
    storageDeposit, storageWithdraw,
    // Farming
    getFarmPlots, plant, water, harvest,
    // Crafting
    getUnlockedRecipes, craft, rollRecipeUnlock, isNearStation,
    // Combat
    attackPlayer, handleDeath, getBattleStats,
    dodgeRoll, isInvulnerable, getWeaponInfo,
    enterDungeon, fightMonster,
    // Mobs
    spawnMobs, mobTick, attackMob, getMobStates, regenHealth,
    // Ground Items
    dropGroundItem, pickupGroundItem, getGroundItemStates, cleanupGroundItems,
    // Equipment
    equipItem, unequipItem, recalcCombatStats,
    // Cosmetics
    equipCosmetic, unequipCosmetic,
    // Effects
    useConsumable, getActiveEffects,
    // Food
    eatFood, getActiveFoodBuff, drainSprintStamina,
    // Agility & Stamina
    getAgilityBonuses, getAgilityStats, regenStaminaTick, trackMovement,
    // Leaderboards
    getLeaderboard,
    // Daily quests
    getDailyQuests, claimDailyQuest,
    // Multiplayer
    updateLivePlayer, removeLivePlayer, getLivePlayers,
    // Achievements
    getAchievements, flushPendingAchievements, ACHIEVEMENTS,
    // Weather
    tickWeather, getWeather,
    // Treasure Chests
    spawnChests, openChest, cleanupChests, getChestStates, CHEST_TIERS,
};
