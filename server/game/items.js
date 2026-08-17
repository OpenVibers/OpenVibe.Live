/**
 * OpenVibeGame — Item Catalog, Structures, World Generation, Shared Utilities
 * Rust-style open-world survival game
 */

// ── Map Constants ────────────────────────────────────────────
const MAP_W = 512;
const MAP_H = 512;
const TILE = 32;
const OUTPOST_X = Math.floor(MAP_W / 2); // 256
const OUTPOST_Y = Math.floor(MAP_H / 2);
const OUTPOST_RADIUS = 14;

// ── Procedural Villages (3 NPC settlements on separate islands) ──
// Placed at offsets from center — each acts as a mini safe-zone with NPCs
const VILLAGES = [
    { id: 'fishing_village', name: 'Fishing Village',  cx: OUTPOST_X - 80, cy: OUTPOST_Y - 70, radius: 8 },
    { id: 'mining_camp',     name: 'Mining Camp',      cx: OUTPOST_X + 85, cy: OUTPOST_Y - 60, radius: 8 },
    { id: 'forest_hamlet',   name: 'Forest Hamlet',    cx: OUTPOST_X - 50, cy: OUTPOST_Y + 90, radius: 8 },
];

const RARITY_COLORS = {
    Junk: '#888888', Common: '#b0b0b0', Uncommon: '#4fc94f',
    Rare: '#3b82f6', Epic: '#a855f7', Legendary: '#f59e0b', Mythic: '#ef4444',
};

const BIOME_COLORS = {
    water: '#1e40af', sand: '#d4a053', grass: '#22c55e', forest: '#166534',
    desert: '#92400e', hills: '#78716c', mountain: '#44403c', snow: '#cbd5e1',
    outpost: '#92702e',
};

// ── Noise Functions (shared client/server) ───────────────────
function hashNoise(x, y, seed) {
    let h = seed;
    h = Math.imul(h ^ (x * 374761393), 1103515245);
    h = Math.imul(h ^ (y * 668265263), 1103515245);
    h = (h ^ (h >> 13)) * 1103515245;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function smoothNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const n00 = hashNoise(ix, iy, seed), n10 = hashNoise(ix + 1, iy, seed);
    const n01 = hashNoise(ix, iy + 1, seed), n11 = hashNoise(ix + 1, iy + 1, seed);
    return (n00 + sx * (n10 - n00)) + sy * ((n01 + sx * (n11 - n01)) - (n00 + sx * (n10 - n00)));
}

function fbm(x, y, seed, octaves) {
    let v = 0, a = 1, f = 1, t = 0;
    for (let i = 0; i < octaves; i++) {
        v += smoothNoise(x * f, y * f, seed + i * 1000) * a;
        t += a; a *= 0.5; f *= 2;
    }
    return v / t;
}

function getBiome(elev, moist) {
    if (elev < 0.30) return 'water';
    if (elev < 0.35) return 'sand';
    if (elev > 0.82) return 'snow';
    if (elev > 0.68) return 'mountain';
    if (elev > 0.55) return 'hills';
    if (moist > 0.58) return 'forest';
    if (moist < 0.35) return 'desert';
    return 'grass';
}

// ── Road corridor segments (outpost ↔ each village) for land guarantee ──
const ROAD_SEGMENTS = VILLAGES.map(v => ({
    x1: OUTPOST_X, y1: OUTPOST_Y, x2: v.cx, y2: v.cy
}));

// Minimum distance from point (px,py) to any road corridor segment
function distToRoadCorridor(px, py) {
    let minD = Infinity;
    for (const seg of ROAD_SEGMENTS) {
        const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) { minD = Math.min(minD, Math.sqrt((px - seg.x1) ** 2 + (py - seg.y1) ** 2)); continue; }
        const t = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq));
        const projX = seg.x1 + t * dx, projY = seg.y1 + t * dy;
        const d = Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
        if (d < minD) minD = d;
    }
    return minD;
}

function getBiomeAt(tx, ty, seed) {
    // Main outpost override
    const dx = tx - OUTPOST_X, dy = ty - OUTPOST_Y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= OUTPOST_RADIUS) return 'outpost';
    // Village overrides (3 procedural NPC villages)
    for (const v of VILLAGES) {
        const vdx = tx - v.cx, vdy = ty - v.cy;
        const vdist = Math.sqrt(vdx * vdx + vdy * vdy);
        if (vdist <= v.radius) return 'outpost';
    }
    // Water border (outer 3 tiles)
    if (tx < 3 || ty < 3 || tx >= MAP_W - 3 || ty >= MAP_H - 3) return 'water';
    let elev = fbm(tx / 40, ty / 40, seed, 6);
    const moist = fbm(tx / 35, ty / 35, seed + 5000, 4);
    // Guarantee land near outpost — boost elevation within 60 tiles
    if (dist < 60) {
        const t = (60 - dist) / (60 - OUTPOST_RADIUS);
        const minElev = 0.35 + t * 0.20;
        elev = Math.max(elev, minElev);
    }
    // Guarantee land near villages
    for (const v of VILLAGES) {
        const vdx = tx - v.cx, vdy = ty - v.cy;
        const vdist = Math.sqrt(vdx * vdx + vdy * vdy);
        if (vdist < 30) {
            const t = (30 - vdist) / (30 - v.radius);
            const minElev = 0.35 + t * 0.15;
            elev = Math.max(elev, minElev);
        }
    }
    // Guarantee land along inter-town road corridors (5-tile-wide strip)
    const roadDist = distToRoadCorridor(tx, ty);
    if (roadDist < 5) {
        const t = 1 - roadDist / 5;
        const minElev = 0.36 + t * 0.14; // center of road: 0.50, edge: 0.36
        elev = Math.max(elev, minElev);
    }
    return getBiome(elev, moist);
}

function getDifficultyTier(tx, ty) {
    const dx = tx - OUTPOST_X, dy = ty - OUTPOST_Y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Also check distance to villages (villages lower local difficulty)
    let minVillageDist = Infinity;
    for (const v of VILLAGES) {
        const vd = Math.sqrt((tx - v.cx) ** 2 + (ty - v.cy) ** 2);
        if (vd < minVillageDist) minVillageDist = vd;
    }
    const effectiveDist = Math.min(dist, minVillageDist + 40);
    if (effectiveDist < 30) return 0;
    if (effectiveDist < 70) return 1;
    if (effectiveDist < 140) return 2;
    return 3;
}

// ── Pickaxe Tiers (determines what ores you can mine) ────────
const PICK_TIERS = {
    pick_wood:    { tier: 0, name: 'Wooden' },   // stone, copper
    pick_stone:   { tier: 1, name: 'Stone' },     // + iron
    pick_iron:    { tier: 2, name: 'Iron' },      // + gold
    pick_gold:    { tier: 3, name: 'Gold' },      // + mithril, titanium
    pick_diamond: { tier: 4, name: 'Diamond' },   // + platinum, dragonite
};

// ── Axe Tiers (determines what trees you can chop) ──────────
const AXE_TIERS = {
    axe_stone:   { tier: 0, name: 'Stone' },
    axe_iron:    { tier: 1, name: 'Iron' },
    axe_steel:   { tier: 2, name: 'Steel' },
    axe_mythril: { tier: 3, name: 'Mythril' },
};

// ── Ore Node Types (affects what you mine) ───────────────────
// Each rock tile gets an ore subtype based on biome + a second noise hash
const ORE_NODE_TYPES = {
    stone:    { emoji: '🪨', color: '#6b7280', minPickTier: -1, minLevel: 1,  name: 'Stone' },   // fists OK
    tin:      { emoji: '🔘', color: '#8a9a9a', minPickTier: 0,  minLevel: 1,  name: 'Tin' },
    copper:   { emoji: '🟤', color: '#b87333', minPickTier: 0,  minLevel: 1,  name: 'Copper' },
    coal:     { emoji: '⬛', color: '#374151', minPickTier: 0,  minLevel: 5,  name: 'Coal' },
    iron:     { emoji: '⚙️', color: '#a8a8a8', minPickTier: 1,  minLevel: 10, name: 'Iron' },
    gold:     { emoji: '🥇', color: '#ffd700', minPickTier: 2,  minLevel: 20, name: 'Gold' },
    mithril:  { emoji: '💠', color: '#7dd3fc', minPickTier: 3,  minLevel: 35, name: 'Mithril' },
    titanium: { emoji: '⬜', color: '#e2e8f0', minPickTier: 3,  minLevel: 45, name: 'Titanium' },
    platinum: { emoji: '🪙', color: '#d4d4d8', minPickTier: 4,  minLevel: 55, name: 'Platinum' },
    dragonite:{ emoji: '🐉', color: '#dc2626', minPickTier: 4,  minLevel: 65, name: 'Dragonite' },
};

function getOreNodeType(tx, ty, seed, biome) {
    const h2 = hashNoise(tx, ty, seed + 77777); // second noise layer for ore type
    // Biome-specific ore distribution — tin & coal appear in starter zones
    if (biome === 'grass') {
        return h2 < 0.30 ? 'stone' : h2 < 0.50 ? 'tin' : h2 < 0.72 ? 'copper' : h2 < 0.88 ? 'coal' : 'iron';
    }
    if (biome === 'hills') {
        return h2 < 0.15 ? 'stone' : h2 < 0.28 ? 'tin' : h2 < 0.42 ? 'copper' : h2 < 0.55 ? 'coal' : h2 < 0.72 ? 'iron' : h2 < 0.88 ? 'gold' : 'mithril';
    }
    if (biome === 'mountain') {
        return h2 < 0.10 ? 'coal' : h2 < 0.25 ? 'iron' : h2 < 0.42 ? 'gold' : h2 < 0.58 ? 'mithril' : h2 < 0.74 ? 'titanium' : h2 < 0.90 ? 'platinum' : 'dragonite';
    }
    if (biome === 'snow') {
        return h2 < 0.15 ? 'coal' : h2 < 0.30 ? 'iron' : h2 < 0.50 ? 'gold' : h2 < 0.70 ? 'mithril' : h2 < 0.88 ? 'titanium' : 'platinum';
    }
    if (biome === 'desert') {
        return h2 < 0.25 ? 'stone' : h2 < 0.45 ? 'copper' : h2 < 0.60 ? 'coal' : h2 < 0.80 ? 'gold' : 'iron';
    }
    // Default (sand, forest fallback)
    return h2 < 0.35 ? 'stone' : h2 < 0.55 ? 'tin' : h2 < 0.78 ? 'copper' : 'coal';
}

function getResourceNodeAt(tx, ty, seed) {
    const biome = getBiomeAt(tx, ty, seed);
    if (biome === 'water' || biome === 'outpost') return null;
    const h = hashNoise(tx, ty, seed + 99999);
    // Forest: dense trees
    if (biome === 'forest' && h < 0.22) return { type: 'tree' };
    // Grass: scattered trees + occasional rocks
    if (biome === 'grass') {
        if (h < 0.08) return { type: 'tree' };
        if (h > 0.95) return { type: 'rock', ore: getOreNodeType(tx, ty, seed, biome) };
    }
    // Hills: rocks + rare trees
    if (biome === 'hills') {
        if (h < 0.12) return { type: 'rock', ore: getOreNodeType(tx, ty, seed, biome) };
        if (h > 0.93) return { type: 'tree' };
    }
    // Mountain: dense rocks
    if (biome === 'mountain' && h < 0.18) return { type: 'rock', ore: getOreNodeType(tx, ty, seed, biome) };
    // Sand: fish spots along the shore
    if (biome === 'sand') {
        if (h < 0.10) return { type: 'fish_spot' };
        if (h > 0.92) return { type: 'tree' };
    }
    // Snow: rocks + rare gems
    if (biome === 'snow' && h < 0.10) return { type: 'rock', ore: getOreNodeType(tx, ty, seed, biome) };
    // Desert: rocks + dead trees
    if (biome === 'desert') {
        if (h < 0.07) return { type: 'rock', ore: getOreNodeType(tx, ty, seed, biome) };
        if (h > 0.94) return { type: 'tree' };
    }
    return null;
}

function isInSafeZone(tx, ty) {
    const dx = tx - OUTPOST_X, dy = ty - OUTPOST_Y;
    if (Math.sqrt(dx * dx + dy * dy) <= OUTPOST_RADIUS) return true;
    for (const v of VILLAGES) {
        const vd = Math.sqrt((tx - v.cx) ** 2 + (ty - v.cy) ** 2);
        if (vd <= v.radius) return true;
    }
    return false;
}

// ── Items ────────────────────────────────────────────────────
const ITEMS = {
    // Seeds
    seed_wheat:     { name: 'Wheat Seeds',      emoji: '🌾', desc: 'Basic crop. 30 min.',        buyCost: 5,    sellPrice: null, category: 'seeds',   rarity: 'Common' },
    seed_carrot:    { name: 'Carrot Seeds',      emoji: '🥕', desc: '45 min.',                    buyCost: 12,   sellPrice: null, category: 'seeds',   rarity: 'Common' },
    seed_tomato:    { name: 'Tomato Seeds',      emoji: '🍅', desc: '60 min.',                    buyCost: 20,   sellPrice: null, category: 'seeds',   rarity: 'Uncommon' },
    seed_corn:      { name: 'Corn Seeds',        emoji: '🌽', desc: '90 min.',                    buyCost: 30,   sellPrice: null, category: 'seeds',   rarity: 'Uncommon' },
    seed_pumpkin:   { name: 'Pumpkin Seeds',     emoji: '🎃', desc: '2 hours.',                   buyCost: 50,   sellPrice: null, category: 'seeds',   rarity: 'Rare' },
    seed_golden:    { name: 'Golden Seeds',      emoji: '✨', desc: '3 hours. Legendary.',        buyCost: 150,  sellPrice: null, category: 'seeds',   rarity: 'Legendary' },
    // Crops
    crop_wheat:     { name: 'Wheat',             emoji: '🌾', desc: 'Harvested wheat.',           buyCost: null, sellPrice: 18,  category: 'crops',   rarity: 'Common' },
    crop_carrot:    { name: 'Carrots',           emoji: '🥕', desc: 'Fresh carrots.',             buyCost: null, sellPrice: 35,  category: 'crops',   rarity: 'Common' },
    crop_tomato:    { name: 'Tomatoes',          emoji: '🍅', desc: 'Ripe tomatoes.',             buyCost: null, sellPrice: 60,  category: 'crops',   rarity: 'Uncommon' },
    crop_corn:      { name: 'Corn',              emoji: '🌽', desc: 'Golden corn.',               buyCost: null, sellPrice: 90,  category: 'crops',   rarity: 'Uncommon' },
    crop_pumpkin:   { name: 'Pumpkin',           emoji: '🎃', desc: 'Thicc pumpkin.',             buyCost: null, sellPrice: 160, category: 'crops',   rarity: 'Rare' },
    crop_golden:    { name: 'Golden Fruit',      emoji: '✨', desc: 'Mythical produce.',          buyCost: null, sellPrice: 550, category: 'crops',   rarity: 'Legendary' },
    compost:        { name: 'Compost',           emoji: '🫘', desc: '+50% yield.',                buyCost: null, sellPrice: 15,  category: 'tools',   rarity: 'Common' },
    // Fishing tools
    fish_sonar:     { name: 'Fish Sonar',        emoji: '📡', desc: 'Detects fish in water. One use.', buyCost: null, sellPrice: 20,  category: 'tools',   rarity: 'Uncommon' },
    // Bait
    bait_worm:      { name: 'Worms',             emoji: '🪱', desc: 'Basic bait.',                buyCost: 3,    sellPrice: 1,   category: 'bait',    rarity: 'Common' },
    bait_cricket:   { name: 'Crickets',          emoji: '🦗', desc: 'Better bait.',               buyCost: 10,   sellPrice: 4,   category: 'bait',    rarity: 'Common' },
    bait_shrimp:    { name: 'Shrimp',            emoji: '🦐', desc: 'Rare fish bait.',            buyCost: 25,   sellPrice: 10,  category: 'bait',    rarity: 'Uncommon' },
    bait_golden:    { name: 'Golden Lure',       emoji: '🌟', desc: 'Epic fish bait.',            buyCost: 75,   sellPrice: 30,  category: 'bait',    rarity: 'Rare' },
    // Rods (levelReq = fishing level)
    rod_bamboo:     { name: 'Bamboo Rod',        emoji: '🎋', desc: 'Basic rod.',                 buyCost: 15,   sellPrice: 5,   category: 'rods',    rarity: 'Common',   levelReq: 1 },
    rod_fiberglass: { name: 'Fiberglass Rod',    emoji: '🥢', desc: 'Light rod.',                 buyCost: 50,   sellPrice: 18,  category: 'rods',    rarity: 'Common',   levelReq: 8 },
    rod_carbon:     { name: 'Carbon Rod',        emoji: '⚫', desc: 'Strong rod.',                buyCost: 150,  sellPrice: 55,  category: 'rods',    rarity: 'Uncommon', levelReq: 20 },
    rod_titanium:   { name: 'Titanium Rod',      emoji: '🔩', desc: 'Premium rod.',               buyCost: 400,  sellPrice: 150, category: 'rods',    rarity: 'Rare',     levelReq: 35 },
    rod_mythril:    { name: 'Mythril Rod',       emoji: '💜', desc: 'Top-tier rod.',              buyCost: 1000, sellPrice: 375, category: 'rods',    rarity: 'Epic',     levelReq: 50 },
    // Fish — Minnow Family
    fish_minnow:       { name: 'Minnow',            emoji: '🐟', desc: 'Tiny but plentiful.',       buyCost: null, sellPrice: 4,    category: 'fish', rarity: 'Common' },
    fish_sunfish:      { name: 'Sunfish',            emoji: '🌻', desc: 'Warm water lover.',         buyCost: null, sellPrice: 6,    category: 'fish', rarity: 'Common' },
    // Fish — Bass Family
    fish_bass:         { name: 'Bass',               emoji: '🐟', desc: 'Solid catch.',              buyCost: null, sellPrice: 10,   category: 'fish', rarity: 'Common' },
    fish_perch:        { name: 'Perch',              emoji: '🐟', desc: 'Yellow-striped.',           buyCost: null, sellPrice: 8,    category: 'fish', rarity: 'Common' },
    // Fish — Trout Family
    fish_trout:        { name: 'Trout',              emoji: '🐠', desc: 'Speckled beauty.',          buyCost: null, sellPrice: 12,   category: 'fish', rarity: 'Common' },
    fish_clownfish:    { name: 'Clownfish',          emoji: '🤡', desc: 'Found Nemo.',               buyCost: null, sellPrice: 14,   category: 'fish', rarity: 'Common' },
    // Fish — Catfish Family (Tier 1)
    fish_catfish:      { name: 'Catfish',            emoji: '🐡', desc: 'Whiskered bottom-feeder.',  buyCost: null, sellPrice: 18,   category: 'fish', rarity: 'Uncommon' },
    fish_carp:         { name: 'Carp',               emoji: '🐟', desc: 'Golden scales.',            buyCost: null, sellPrice: 16,   category: 'fish', rarity: 'Common' },
    fish_pike:         { name: 'Pike',               emoji: '🐟', desc: 'Lurking predator.',         buyCost: null, sellPrice: 22,   category: 'fish', rarity: 'Uncommon' },
    // Fish — Salmon Family (Tier 1)
    fish_salmon:       { name: 'Salmon',             emoji: '🐠', desc: 'Fresh upstream salmon.',    buyCost: null, sellPrice: 20,   category: 'fish', rarity: 'Uncommon' },
    fish_rainbow_trout:{ name: 'Rainbow Trout',      emoji: '🌈', desc: 'Shimmering colors.',        buyCost: null, sellPrice: 24,   category: 'fish', rarity: 'Uncommon' },
    fish_king_salmon:  { name: 'King Salmon',        emoji: '👑', desc: 'The royal catch.',          buyCost: null, sellPrice: 30,   category: 'fish', rarity: 'Rare' },
    // Fish — Puffer Family (Tier 1)
    fish_pufferfish:   { name: 'Pufferfish',         emoji: '🐡', desc: 'Don\'t poke it.',           buyCost: null, sellPrice: 18,   category: 'fish', rarity: 'Uncommon' },
    fish_jellyfish:    { name: 'Jellyfish',          emoji: '🪼', desc: 'Translucent drifter.',      buyCost: null, sellPrice: 20,   category: 'fish', rarity: 'Uncommon' },
    // Fish — Eel Family (Tier 2)
    fish_electric_eel: { name: 'Electric Eel',       emoji: '⚡', desc: 'Shocking catch.',            buyCost: null, sellPrice: 35,   category: 'fish', rarity: 'Rare' },
    fish_stingray:     { name: 'Stingray',           emoji: '🦟', desc: 'Flat and dangerous.',       buyCost: null, sellPrice: 28,   category: 'fish', rarity: 'Uncommon' },
    // Fish — Swordfish Family (Tier 2)
    fish_swordfish:    { name: 'Swordfish',          emoji: '🗡️', desc: 'Razor-nosed speedster.',   buyCost: null, sellPrice: 40,   category: 'fish', rarity: 'Rare' },
    fish_marlin:       { name: 'Marlin',             emoji: '🏹', desc: 'Deep sea game fish.',       buyCost: null, sellPrice: 45,   category: 'fish', rarity: 'Rare' },
    fish_barracuda:    { name: 'Barracuda',          emoji: '🦷', desc: 'Silver torpedo.',           buyCost: null, sellPrice: 38,   category: 'fish', rarity: 'Rare' },
    // Fish — Deep Sea Family (Tier 2)
    fish_anglerfish:   { name: 'Anglerfish',         emoji: '🏮', desc: 'Lures with light.',         buyCost: null, sellPrice: 42,   category: 'fish', rarity: 'Rare' },
    fish_octopus:      { name: 'Octopus',            emoji: '🐙', desc: 'Eight-armed escape artist.',buyCost: null, sellPrice: 48,   category: 'fish', rarity: 'Rare' },
    // Fish — Shark Family (Tier 3)
    fish_shark:        { name: 'Shark',              emoji: '🦈', desc: 'Jaws.',                     buyCost: null, sellPrice: 60,   category: 'fish', rarity: 'Epic' },
    fish_hammerhead:   { name: 'Hammerhead',         emoji: '🔨', desc: 'Weird but fearsome.',       buyCost: null, sellPrice: 75,   category: 'fish', rarity: 'Epic' },
    fish_ghost_fish:   { name: 'Ghost Fish',         emoji: '👻', desc: 'Transparent and eerie.',    buyCost: null, sellPrice: 70,   category: 'fish', rarity: 'Epic' },
    // Fish — Whale Family (Tier 3)
    fish_whale:        { name: 'Whale',              emoji: '🐳', desc: 'Absolute unit.',            buyCost: null, sellPrice: 90,   category: 'fish', rarity: 'Epic' },
    fish_narwhal:      { name: 'Narwhal',            emoji: '🦄', desc: 'Unicorn of the sea.',       buyCost: null, sellPrice: 95,   category: 'fish', rarity: 'Epic' },
    // Fish — Legendary Family (Tier 4)
    fish_kraken:       { name: 'Kraken Tentacle',    emoji: '🦑', desc: 'Proof of bravery.',         buyCost: null, sellPrice: 200,  category: 'fish', rarity: 'Legendary' },
    fish_golden:       { name: 'Golden Fish',        emoji: '🏆', desc: 'The legendary one!',        buyCost: null, sellPrice: 300,  category: 'fish', rarity: 'Legendary' },
    fish_leviathan:    { name: 'Leviathan Scale',    emoji: '🐲', desc: 'From the abyss itself.',    buyCost: null, sellPrice: 500,  category: 'fish', rarity: 'Legendary' },
    // Junk (fishing)
    fish_boot:         { name: 'Old Boot',           emoji: '👢', desc: 'Not worth it.',             buyCost: null, sellPrice: 1,    category: 'junk', rarity: 'Junk' },
    fish_tin_can:      { name: 'Tin Can',            emoji: '🥫', desc: 'Soggy garbage.',            buyCost: null, sellPrice: 1,    category: 'junk', rarity: 'Junk' },
    // Raw materials
    raw_stone:      { name: 'Stone',             emoji: '🪨', desc: 'Basic rock.',                buyCost: null, sellPrice: 1,    category: 'materials', rarity: 'Junk' },
    raw_flint:      { name: 'Flint',             emoji: '🔥', desc: 'Sharp stone.',               buyCost: null, sellPrice: 2,    category: 'materials', rarity: 'Common' },
    raw_stick:      { name: 'Stick',             emoji: '🌿', desc: 'A plain stick.',             buyCost: null, sellPrice: 1,    category: 'materials', rarity: 'Junk' },
    // Ores & Gems
    ore_gravel:     { name: 'Gravel',            emoji: '🪨', desc: 'Boring rocks.',              buyCost: null, sellPrice: 3,    category: 'ores', rarity: 'Junk' },
    ore_tin:        { name: 'Tin Ore',           emoji: '🔘', desc: 'Soft tin.',                  buyCost: null, sellPrice: 6,    category: 'ores', rarity: 'Common' },
    ore_coal:       { name: 'Coal',              emoji: '⬛', desc: 'Fuel source.',               buyCost: null, sellPrice: 8,    category: 'ores', rarity: 'Common' },
    ore_copper:     { name: 'Copper Ore',        emoji: '🟤', desc: 'Soft metal.',                buyCost: null, sellPrice: 10,   category: 'ores', rarity: 'Common' },
    ore_iron:       { name: 'Iron Ore',          emoji: '⚙️', desc: 'Solid iron.',               buyCost: null, sellPrice: 15,   category: 'ores', rarity: 'Common' },
    ore_gold:       { name: 'Gold Nugget',       emoji: '🥇', desc: 'Shiny gold.',               buyCost: null, sellPrice: 35,   category: 'ores', rarity: 'Uncommon' },
    ore_mithril:    { name: 'Mithril Ore',       emoji: '💠', desc: 'Enchanted metal.',           buyCost: null, sellPrice: 55,   category: 'ores', rarity: 'Rare' },
    ore_titanium:   { name: 'Titanium Ore',      emoji: '⬜', desc: 'Incredibly strong.',         buyCost: null, sellPrice: 70,   category: 'ores', rarity: 'Rare' },
    ore_platinum:   { name: 'Platinum Ore',      emoji: '🪙', desc: 'Rarer than gold.',           buyCost: null, sellPrice: 90,   category: 'ores', rarity: 'Epic' },
    ore_dragonite:  { name: 'Dragonite Ore',     emoji: '🐉', desc: 'Mythically rare.',           buyCost: null, sellPrice: 250,  category: 'ores', rarity: 'Legendary' },
    gem_ruby:       { name: 'Ruby',              emoji: '🔴', desc: 'Red gemstone.',              buyCost: null, sellPrice: 45,   category: 'gems', rarity: 'Uncommon' },
    gem_emerald:    { name: 'Emerald',           emoji: '💚', desc: 'Green gem.',                 buyCost: null, sellPrice: 65,   category: 'gems', rarity: 'Rare' },
    gem_diamond:    { name: 'Diamond',           emoji: '💎', desc: 'The hardest gem.',           buyCost: null, sellPrice: 100,  category: 'gems', rarity: 'Rare' },
    gem_star:       { name: 'Star Fragment',     emoji: '⭐', desc: 'Fallen star shard.',         buyCost: null, sellPrice: 180,  category: 'gems', rarity: 'Epic' },
    mine_void_stone:{ name: 'Void Stone',        emoji: '🕳️', desc: 'Absorbs light.',            buyCost: null, sellPrice: 500,  category: 'gems', rarity: 'Legendary' },
    // Bars
    bar_bronze:     { name: 'Bronze Bar',        emoji: '🟫', desc: 'Tin + Copper alloy.',         buyCost: null, sellPrice: 16,   category: 'bars', rarity: 'Common' },
    bar_copper:     { name: 'Copper Bar',        emoji: '🟤', desc: 'Pure copper.',               buyCost: null, sellPrice: 18,   category: 'bars', rarity: 'Common' },
    bar_iron:       { name: 'Iron Bar',          emoji: '🔩', desc: 'Crafting material.',         buyCost: null, sellPrice: 25,   category: 'bars', rarity: 'Common' },
    bar_steel:      { name: 'Steel Bar',         emoji: '🔗', desc: 'Iron + Coal alloy.',          buyCost: null, sellPrice: 40,   category: 'bars', rarity: 'Uncommon' },
    bar_gold:       { name: 'Gold Bar',          emoji: '🟡', desc: 'Valuable bar.',              buyCost: null, sellPrice: 60,   category: 'bars', rarity: 'Uncommon' },
    bar_mithril:    { name: 'Mithril Bar',       emoji: '💠', desc: 'Light and strong.',          buyCost: null, sellPrice: 100,  category: 'bars', rarity: 'Rare' },
    bar_titanium:   { name: 'Titanium Bar',      emoji: '⬜', desc: 'Incredibly durable.',        buyCost: null, sellPrice: 130,  category: 'bars', rarity: 'Rare' },
    bar_platinum:   { name: 'Platinum Bar',      emoji: '🪙', desc: 'Premium metal.',             buyCost: null, sellPrice: 160,  category: 'bars', rarity: 'Epic' },
    bar_dragonite:  { name: 'Dragonite Bar',     emoji: '🐉', desc: 'The finest bar.',            buyCost: null, sellPrice: 450,  category: 'bars', rarity: 'Legendary' },
    // Pickaxes (levelReq = mining level)
    pick_wood:      { name: 'Wooden Pickaxe',    emoji: '🪵', desc: 'Flimsy pick. Mines copper.',  buyCost: 10,   sellPrice: null, category: 'pickaxes', rarity: 'Common',   levelReq: 1 },
    pick_stone:     { name: 'Stone Pickaxe',     emoji: '⛏️', desc: 'Mines iron.',                buyCost: null, sellPrice: 8,    category: 'pickaxes', rarity: 'Common',   levelReq: 5 },
    pick_iron:      { name: 'Iron Pickaxe',      emoji: '⛏️', desc: 'Mines gold.',                buyCost: 50,   sellPrice: null, category: 'pickaxes', rarity: 'Uncommon', levelReq: 15 },
    pick_gold:      { name: 'Gold Pickaxe',      emoji: '✨', desc: 'Mines mithril.',              buyCost: 150,  sellPrice: null, category: 'pickaxes', rarity: 'Rare',     levelReq: 30 },
    pick_diamond:   { name: 'Diamond Pickaxe',   emoji: '💎', desc: 'Mines everything.',           buyCost: 400,  sellPrice: null, category: 'pickaxes', rarity: 'Epic',     levelReq: 45 },
    // Axes (levelReq = woodcut level)
    axe_stone:      { name: 'Stone Axe',         emoji: '🪓', desc: 'Basic axe.',                 buyCost: 8,    sellPrice: null, category: 'axes', rarity: 'Common',   levelReq: 1 },
    axe_iron:       { name: 'Iron Axe',          emoji: '⛏️', desc: 'Cuts hardwood.',            buyCost: 40,   sellPrice: null, category: 'axes', rarity: 'Uncommon', levelReq: 10 },
    axe_steel:      { name: 'Steel Axe',         emoji: '🔧', desc: 'Ancient trees.',             buyCost: 120,  sellPrice: null, category: 'axes', rarity: 'Rare',     levelReq: 25 },
    axe_mythril:    { name: 'Mythril Axe',       emoji: '💠', desc: 'Cuts anything.',             buyCost: 350,  sellPrice: null, category: 'axes', rarity: 'Epic',     levelReq: 40 },
    // Wood
    wood_twig:      { name: 'Twig',              emoji: '🌿', desc: 'A sad twig.',                buyCost: null, sellPrice: 2,    category: 'wood', rarity: 'Junk' },
    wood_oak:       { name: 'Oak Log',           emoji: '🪵', desc: 'Standard oak.',              buyCost: null, sellPrice: 8,    category: 'wood', rarity: 'Common' },
    wood_maple:     { name: 'Maple Log',         emoji: '🍁', desc: 'Beautiful maple.',           buyCost: null, sellPrice: 16,   category: 'wood', rarity: 'Common' },
    wood_birch:     { name: 'Birch Log',         emoji: '🌳', desc: 'Smooth birch.',              buyCost: null, sellPrice: 24,   category: 'wood', rarity: 'Uncommon' },
    wood_mahogany:  { name: 'Mahogany Log',      emoji: '🟤', desc: 'Dark hardwood.',             buyCost: null, sellPrice: 40,   category: 'wood', rarity: 'Uncommon' },
    wood_yew:       { name: 'Yew Log',           emoji: '🌲', desc: 'Ancient yew.',               buyCost: null, sellPrice: 65,   category: 'wood', rarity: 'Uncommon' },
    wood_elder:     { name: 'Elderwood Log',     emoji: '🧙', desc: 'Magical wood.',              buyCost: null, sellPrice: 110,  category: 'wood', rarity: 'Rare' },
    wood_crystal:   { name: 'Crystal Wood',      emoji: '💎', desc: 'Incredibly rare.',           buyCost: null, sellPrice: 150,  category: 'wood', rarity: 'Epic' },
    wood_sap:       { name: 'Tree Sap',          emoji: '🍯', desc: 'Sticky but useful.',         buyCost: null, sellPrice: 12,   category: 'wood', rarity: 'Common' },
    wood_spirit:    { name: 'Tree Spirit Shard', emoji: '👻', desc: 'From an angry spirit.',      buyCost: null, sellPrice: 350,  category: 'wood', rarity: 'Legendary' },
    // Crafted
    craft_plank:       { name: 'Wooden Plank',       emoji: '🪵', desc: 'Building material.',     buyCost: null, sellPrice: 15,  category: 'crafted', rarity: 'Common' },
    craft_charcoal:    { name: 'Charcoal',           emoji: '⬛', desc: 'Refined fuel.',           buyCost: null, sellPrice: 20,  category: 'crafted', rarity: 'Uncommon' },
    craft_arrow:       { name: 'Quiver of Arrows',   emoji: '🏹', desc: 'Deadly arrows.',         buyCost: null, sellPrice: 30,  category: 'crafted', rarity: 'Uncommon' },
    craft_shield:      { name: 'Wooden Shield',      emoji: '🛡️', desc: 'Basic defense.',        buyCost: null, sellPrice: 40,  category: 'crafted', rarity: 'Uncommon' },
    craft_totem:       { name: 'Spirit Totem',       emoji: '🗿', desc: 'Carved totem.',           buyCost: null, sellPrice: 100, category: 'crafted', rarity: 'Rare' },
    craft_wand:        { name: 'Crystal Wand',       emoji: '🪄', desc: 'Magical focus.',          buyCost: null, sellPrice: 180, category: 'crafted', rarity: 'Epic' },
    craft_crown:       { name: 'Crown of Thorns',    emoji: '👑', desc: 'Painful but regal.',      buyCost: null, sellPrice: 250, category: 'crafted', rarity: 'Epic' },
    craft_golem:       { name: 'Iron Golem Core',    emoji: '🤖', desc: 'Metal beast heart.',      buyCost: null, sellPrice: 300, category: 'crafted', rarity: 'Epic' },
    // Consumables
    craft_elixir:      { name: 'Elixir of Fortune',  emoji: '🧪', desc: '2x coins 10 min.',       buyCost: null, sellPrice: 60,  category: 'consumable', rarity: 'Uncommon' },
    craft_xp_potion:   { name: 'XP Boost Potion',    emoji: '⚗️', desc: '2x XP 10 min.',         buyCost: null, sellPrice: 50,  category: 'consumable', rarity: 'Uncommon' },
    craft_loot_magnet: { name: 'Loot Magnet',        emoji: '🧲', desc: 'Better loot 5 actions.', buyCost: null, sellPrice: 80,  category: 'consumable', rarity: 'Uncommon' },
    supp_stamina:      { name: 'Stamina Pill',       emoji: '⚡', desc: '+50 stamina.',            buyCost: 20,   sellPrice: 8,   category: 'consumable', rarity: 'Common' },
    farm_plot:         { name: 'Farm Plot Deed',     emoji: '📜', desc: 'Extra farm plot.',        buyCost: 200,  sellPrice: null, category: 'tools', rarity: 'Epic' },
    fertilizer:        { name: 'Fertilizer',         emoji: '💩', desc: '2x crop yield.',          buyCost: 40,   sellPrice: null, category: 'tools', rarity: 'Uncommon' },
    // Weapons & Armor (levelReq = combat level)
    weapon_fist:       { name: 'Fists',              emoji: '👊', desc: '+0 ATK. Punch stuff!',      buyCost: null, sellPrice: null, category: 'weapons', rarity: 'Junk',      levelReq: 1, weaponSpeed: 1.0, weaponRange: 1.0 },
    weapon_rock:       { name: 'Sharp Rock',         emoji: '🪨', desc: '+1 ATK. Fast but short.',   buyCost: null, sellPrice: 1,   category: 'weapons', rarity: 'Junk',      levelReq: 1, weaponSpeed: 1.2, weaponRange: 0.8 },
    weapon_stick:      { name: 'Wooden Stick',       emoji: '🏏', desc: '+2 ATK. Long reach.',       buyCost: 5,    sellPrice: 2,   category: 'weapons', rarity: 'Common',    levelReq: 1, weaponSpeed: 1.3, weaponRange: 1.2 },
    weapon_sword:      { name: 'Iron Sword',         emoji: '⚔️', desc: '+8 ATK. Balanced.',        buyCost: 80,   sellPrice: 30,  category: 'weapons', rarity: 'Uncommon',  levelReq: 8, weaponSpeed: 1.0, weaponRange: 1.2 },
    weapon_axe:        { name: 'Battle Axe',         emoji: '🪓', desc: '+15 ATK. Slow & brutal.',   buyCost: 250,  sellPrice: 90,  category: 'weapons', rarity: 'Rare',      levelReq: 18, weaponSpeed: 0.7, weaponRange: 1.0 },
    weapon_katana:     { name: 'Shadow Katana',      emoji: '🗡️', desc: '+25 ATK. Lightning fast.', buyCost: 600,  sellPrice: 220, category: 'weapons', rarity: 'Epic',      levelReq: 30, weaponSpeed: 1.4, weaponRange: 1.3 },
    weapon_legendary:  { name: 'Dragonslayer',       emoji: '🐲', desc: '+40 ATK. The ultimate.',    buyCost: null, sellPrice: 800, category: 'weapons', rarity: 'Legendary', levelReq: 45, weaponSpeed: 1.1, weaponRange: 1.4 },
    armor_cloth:       { name: 'Cloth Armor',        emoji: '👕', desc: '+3 DEF.',                buyCost: 10,   sellPrice: 4,   category: 'armor',  rarity: 'Common',    levelReq: 1 },
    armor_leather:     { name: 'Leather Armor',      emoji: '🦺', desc: '+8 DEF.',                buyCost: 60,   sellPrice: 22,  category: 'armor',  rarity: 'Uncommon',  levelReq: 5 },
    armor_chain:       { name: 'Chainmail',          emoji: '⛓️', desc: '+15 DEF.',              buyCost: 200,  sellPrice: 75,  category: 'armor',  rarity: 'Rare',      levelReq: 15 },
    armor_plate:       { name: 'Plate Armor',        emoji: '🛡️', desc: '+25 DEF.',              buyCost: 500,  sellPrice: 185, category: 'armor',  rarity: 'Epic',      levelReq: 30 },
    armor_dragonscale: { name: 'Dragonscale Armor',  emoji: '🐉', desc: '+40 DEF.',               buyCost: null, sellPrice: 700, category: 'armor',  rarity: 'Legendary', levelReq: 45 },
    // Hats
    hat_basic_cap:     { name: 'Basic Cap',          emoji: '🧢', desc: 'Simple cap.',             buyCost: 50,   sellPrice: 20,  category: 'hats', rarity: 'Common' },
    hat_cowboy:        { name: 'Cowboy Hat',         emoji: '🤠', desc: 'Yeehaw.',                 buyCost: null, sellPrice: 100, category: 'hats', rarity: 'Uncommon' },
    hat_wizard:        { name: 'Wizard Hat',         emoji: '🧙', desc: 'Magical.',                buyCost: null, sellPrice: 200, category: 'hats', rarity: 'Rare' },
    hat_crown:         { name: 'Royal Crown',        emoji: '👑', desc: 'Royalty.',                 buyCost: null, sellPrice: 500, category: 'hats', rarity: 'Epic' },
    hat_halo:          { name: 'Halo',               emoji: '😇', desc: 'Angelic.',                 buyCost: null, sellPrice: 800, category: 'hats', rarity: 'Legendary' },
    hat_void_crown:    { name: 'Void Crown',         emoji: '🕳️', desc: 'Dungeon only.',          buyCost: null, sellPrice: 1500,category: 'hats', rarity: 'Mythic' },
    // Name & Particle Effects
    fx_rainbow:        { name: 'Rainbow Name',       emoji: '🌈', desc: 'Rainbow cycling!',       buyCost: 1500,  sellPrice: null, category: 'name_effects', rarity: 'Rare',    coinPrice: 500 },
    fx_fire:           { name: 'Fire Name',          emoji: '🔥', desc: 'Blazing flames!',        buyCost: 2000,  sellPrice: null, category: 'name_effects', rarity: 'Rare',    coinPrice: 650 },
    fx_ice:            { name: 'Ice Name',           emoji: '❄️', desc: 'Frosty glow!',           buyCost: 2000,  sellPrice: null, category: 'name_effects', rarity: 'Rare',    coinPrice: 650 },
    fx_golden:         { name: 'Golden Name',        emoji: '👑', desc: 'Golden shine!',           buyCost: 3500,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1200 },
    fx_neon:           { name: 'Neon Name',          emoji: '💡', desc: 'Neon pulse!',             buyCost: 3500,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1200 },
    fx_galaxy:         { name: 'Galaxy Name',        emoji: '🌌', desc: 'Cosmic swirl!',           buyCost: 5000,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1800 },
    fx_void:           { name: 'Void Name',          emoji: '🕳️', desc: 'Warps space!',           buyCost: 15000, sellPrice: null, category: 'name_effects', rarity: 'Legendary', coinPrice: 5000 },
    fx_toxic:          { name: 'Toxic Name',         emoji: '☠️', desc: 'Toxic drip!',             buyCost: 2000,  sellPrice: null, category: 'name_effects', rarity: 'Rare',    coinPrice: 650 },
    fx_blood:          { name: 'Blood Name',         emoji: '🩸', desc: 'Dripping blood!',         buyCost: 5000,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1800 },
    fx_shadow:         { name: 'Shadow Name',        emoji: '🌑', desc: 'Dark shadow!',            buyCost: 5000,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1800 },
    fx_glitch:         { name: 'Glitch Name',        emoji: '📟', desc: 'Digital glitch!',          buyCost: 5000,  sellPrice: null, category: 'name_effects', rarity: 'Epic',    coinPrice: 1800 },
    fx_hologram:       { name: 'Hologram Name',      emoji: '🔮', desc: 'Holographic shimmer!',     buyCost: 10000, sellPrice: null, category: 'name_effects', rarity: 'Legendary', coinPrice: 3500 },
    fx_divine:         { name: 'Divine Name',        emoji: '✝️', desc: 'Divine radiance!',         buyCost: 15000, sellPrice: null, category: 'name_effects', rarity: 'Legendary', coinPrice: 5000 },
    px_sparkle:        { name: 'Sparkle Particles',  emoji: '✨', desc: 'Sparkles!',               buyCost: 1000,  sellPrice: null, category: 'particles', rarity: 'Rare',    coinPrice: 350 },
    px_hearts:         { name: 'Heart Particles',    emoji: '💖', desc: 'Hearts!',                 buyCost: 1500,  sellPrice: null, category: 'particles', rarity: 'Rare',    coinPrice: 500 },
    px_flames:         { name: 'Flame Particles',    emoji: '🔥', desc: 'Embers!',                 buyCost: 3000,  sellPrice: null, category: 'particles', rarity: 'Epic',    coinPrice: 1000 },
    px_stars:          { name: 'Star Particles',     emoji: '⭐', desc: 'Stars orbit!',            buyCost: 3500,  sellPrice: null, category: 'particles', rarity: 'Epic',    coinPrice: 1200 },
    px_void:           { name: 'Void Particles',     emoji: '🕳️', desc: 'Dark matter!',           buyCost: 8000,  sellPrice: null, category: 'particles', rarity: 'Legendary', coinPrice: 2800 },
    // Voices (TTS cosmetics — activate to unlock globally)
    voice_deep:        { name: 'Deep Voice',         emoji: '🎵', desc: 'Low & rumbly TTS.',       buyCost: 800,   sellPrice: null, category: 'voices', rarity: 'Uncommon',  coinPrice: 300 },
    voice_chipmunk:    { name: 'Chipmunk Voice',     emoji: '🐿️', desc: 'Squeaky & fast TTS.',    buyCost: 800,   sellPrice: null, category: 'voices', rarity: 'Uncommon',  coinPrice: 300 },
    voice_robot:       { name: 'Robot Voice',        emoji: '🤖', desc: 'Monotone machine TTS.',   buyCost: 2000,  sellPrice: null, category: 'voices', rarity: 'Rare',      coinPrice: 700 },
    voice_whisper:     { name: 'Whisper Voice',      emoji: '🤫', desc: 'Quiet & eerie TTS.',      buyCost: 2000,  sellPrice: null, category: 'voices', rarity: 'Rare',      coinPrice: 700 },
    voice_demon:       { name: 'Demon Voice',        emoji: '😈', desc: 'From the underworld TTS.',buyCost: 5000,  sellPrice: null, category: 'voices', rarity: 'Epic',      coinPrice: 1800 },
    // Legacy voices (ported from RS-Companion)
    voice_gary:        { name: 'Gary',               emoji: '🔊', desc: 'Standard voice.',           buyCost: null, sellPrice: null, category: 'voices', rarity: 'Common' },
    voice_brenda:      { name: 'Brenda',             emoji: '👩', desc: 'Friendly female voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Common' },
    voice_chadbot:     { name: 'ChadBot',            emoji: '💪', desc: 'Deep bro voice.',           buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_karen:       { name: 'Karen',              emoji: '💅', desc: 'Manager-seeking voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_crackhead:   { name: 'CrackheadCarl',      emoji: '💊', desc: 'Manic energy voice.',       buyCost: null, sellPrice: null, category: 'voices', rarity: 'Rare' },
    voice_squeakmaster:{ name: 'SqueakMaster',       emoji: '🐭', desc: 'Ultra-squeaky voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_bigchungus:  { name: 'BigChungus',         emoji: '🐰', desc: 'Absolute unit voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_tweaker:     { name: 'Tweaker',            emoji: '⚡', desc: 'Fast & nervous voice.',     buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_grandpa:     { name: 'Grandpa',            emoji: '👴', desc: 'Old & wise voice.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_ghostgirl:   { name: 'GhostGirl',          emoji: '👻', desc: 'Eerie whisper voice.',       buyCost: null, sellPrice: null, category: 'voices', rarity: 'Rare' },
    voice_robotoverlord:{ name: 'RobotOverlord',     emoji: '🤖', desc: 'Machine overlord voice.',   buyCost: null, sellPrice: null, category: 'voices', rarity: 'Rare' },
    voice_sassybitch:  { name: 'SassyBitch',         emoji: '💁', desc: 'Sassy attitude voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Rare' },
    voice_helium:      { name: 'Helium',             emoji: '🎈', desc: 'Squeaky helium voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_britbong:    { name: 'BritBong',           emoji: '🇬🇧', desc: 'British accent voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_yeehaw:      { name: 'YeeHaw',             emoji: '🤠', desc: 'Southern drawl voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_nyc:         { name: 'NYC',                emoji: '🗽', desc: 'New York accent voice.',     buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_french:      { name: 'French',             emoji: '🇫🇷', desc: 'French accent voice.',     buyCost: null, sellPrice: null, category: 'voices', rarity: 'Uncommon' },
    voice_chatterbox:  { name: 'Chatterbox',         emoji: '💬', desc: 'Achievement voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_fisherman:   { name: 'Fisherman',          emoji: '🎣', desc: 'Achievement voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_smooth:   { name: 'Smooth Operator',    emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_sally:    { name: 'Silicon Sally',      emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_butler:   { name: 'British Butler',     emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_london:   { name: 'Lady London',        emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_mumbai:   { name: 'Mumbai Mike',        emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_downunder:{ name: 'Down Under',         emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_sheila:   { name: 'Sheila',             emoji: '🎤', desc: 'Google Cloud TTS.',          buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_gc_studio_f: { name: 'Studio Female',      emoji: '🎙️', desc: 'Google Studio voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_gc_studio_m: { name: 'Studio Male',        emoji: '🎙️', desc: 'Google Studio voice.',      buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_pl_joanna:   { name: 'Joanna',             emoji: '🎤', desc: 'Amazon Polly voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_pl_matthew:  { name: 'Matthew',            emoji: '🎤', desc: 'Amazon Polly voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_pl_amy:      { name: 'Amy',                emoji: '🎤', desc: 'Amazon Polly voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_pl_brian:    { name: 'Brian',              emoji: '🎤', desc: 'Amazon Polly voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_pl_olivia:   { name: 'Olivia',             emoji: '🎤', desc: 'Amazon Polly voice.',         buyCost: null, sellPrice: null, category: 'voices', rarity: 'Epic' },
    voice_pl_danielle: { name: 'Danielle',           emoji: '🎤', desc: 'Amazon Polly Long voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_pl_gregory:  { name: 'Gregory',            emoji: '🎤', desc: 'Amazon Polly Long voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_pl_greg_n:   { name: 'Gregory Neural',     emoji: '🧠', desc: 'Amazon Polly Neural voice.', buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_pl_ruth:     { name: 'Ruth',               emoji: '🎤', desc: 'Amazon Polly Long voice.',    buyCost: null, sellPrice: null, category: 'voices', rarity: 'Legendary' },
    voice_pl_arthur:   { name: 'Arthur Neural',      emoji: '🧠', desc: 'Amazon Polly Neural voice.', buyCost: null, sellPrice: null, category: 'voices', rarity: 'Mythic' },
    voice_dwarf_lord:  { name: 'Dwarf Lord',         emoji: '⛏️', desc: 'Skill mastery voice.',       buyCost: null, sellPrice: null, category: 'voices', rarity: 'Mythic' },
    // Health
    potion_health:     { name: 'Health Potion',      emoji: '❤️', desc: 'Restores 30 HP.',        buyCost: 15,   sellPrice: 6,  category: 'consumable', rarity: 'Common' },
    potion_health_big: { name: 'Greater Health Pot',  emoji: '💖', desc: 'Restores 75 HP.',       buyCost: 45,   sellPrice: 18, category: 'consumable', rarity: 'Uncommon' },
    potion_stamina:    { name: 'Stamina Potion',     emoji: '⚡', desc: 'Restores 30 STA.',       buyCost: 12,   sellPrice: 5,  category: 'consumable', rarity: 'Common' },
    food_campfire_meal:{ name: 'Burn Barrel Meal',   emoji: '🍖', desc: 'HP over time.',           buyCost: 25,   sellPrice: 10, category: 'consumable', rarity: 'Uncommon' },
    // Cooked Food (grants buffs — cook at the burn barrel or craft)
    food_cooked_fish:  { name: 'Cooked Fish',        emoji: '🍽️', desc: '+20 HP instantly.',       buyCost: null, sellPrice: 8,   category: 'food', rarity: 'Common' },
    food_fish_stew:    { name: 'Fish Stew',          emoji: '🍲', desc: '+40 HP, +5 ATK 3 min.',   buyCost: null, sellPrice: 25,  category: 'food', rarity: 'Uncommon' },
    food_grilled_meat: { name: 'Grilled Meat',       emoji: '🥩', desc: '+30 HP instantly.',        buyCost: null, sellPrice: 15,  category: 'food', rarity: 'Common' },
    food_veggie_soup:  { name: 'Veggie Soup',        emoji: '🥣', desc: '+25 HP, +5 DEF 3 min.',   buyCost: null, sellPrice: 20,  category: 'food', rarity: 'Uncommon' },
    food_golden_feast: { name: 'Golden Feast',       emoji: '🍽️', desc: '+75 HP, +10 ATK/DEF 5 min.', buyCost: null, sellPrice: 100, category: 'food', rarity: 'Epic' },
    food_trail_mix:    { name: 'Trail Mix',          emoji: '🥜', desc: '+30 STA, free sprint 2 min.', buyCost: null, sellPrice: 12, category: 'food', rarity: 'Common' },
    food_pumpkin_pie:  { name: 'Pumpkin Pie',        emoji: '🥧', desc: '+50 HP, +2x XP 2 min.',   buyCost: null, sellPrice: 50,  category: 'food', rarity: 'Rare' },
    food_energy_bar:   { name: 'Energy Bar',         emoji: '🍫', desc: '+50 STA, +20 max STA 5 min.', buyCost: null, sellPrice: 30, category: 'food', rarity: 'Uncommon' },
    // Loot drops
    loot_lint:         { name: 'Pocket Lint',        emoji: '🧶', desc: 'Always there.',           buyCost: null, sellPrice: 1,   category: 'junk', rarity: 'Junk' },
    loot_coin_pouch:   { name: 'Coin Pouch',         emoji: '👛', desc: 'Some coins.',             buyCost: null, sellPrice: 15,  category: 'loot', rarity: 'Common' },
    loot_feather:      { name: 'Phoenix Feather',    emoji: '🪶', desc: 'Warm touch.',             buyCost: null, sellPrice: 20,  category: 'loot', rarity: 'Uncommon' },
    loot_crown:        { name: 'Tiny Crown',         emoji: '👑', desc: 'Hamster king.',           buyCost: null, sellPrice: 60,  category: 'loot', rarity: 'Rare' },
    loot_egg:          { name: 'Dragon Egg',         emoji: '🥚', desc: 'Is it moving??',          buyCost: null, sellPrice: 200, category: 'loot', rarity: 'Epic' },
    loot_star:         { name: 'Fallen Star',        emoji: '🌟', desc: 'Piece of cosmos.',        buyCost: null, sellPrice: 500, category: 'loot', rarity: 'Legendary' },
    loot_void_heart:   { name: 'Void Heart',         emoji: '🖤', desc: 'Dying universe.',         buyCost: null, sellPrice: 1000, category: 'loot', rarity: 'Legendary' },
    // Dungeon keys
    dungeon_key:       { name: 'Dungeon Key',        emoji: '🗝️', desc: 'Opens dungeon.',        buyCost: 100,  sellPrice: 40,  category: 'tools', rarity: 'Rare' },
};

// ── Structures (buildable in the world) ──────────────────────
const STRUCTURES = {
    wall_wood:      { name: 'Wood Wall',     emoji: '🟫', hp: 200, cost: { craft_plank: 3 },                   category: 'wall' },
    wall_stone:     { name: 'Stone Wall',    emoji: '🧱', hp: 500, cost: { bar_iron: 2, ore_gravel: 5 },       category: 'wall' },
    door_wood:      { name: 'Wood Door',     emoji: '🚪', hp: 150, cost: { craft_plank: 2, bar_iron: 1 },      category: 'door' },
    floor_wood:     { name: 'Wood Floor',    emoji: '📋', hp: 150, cost: { craft_plank: 2 },                   category: 'floor' },
    workbench:      { name: 'Workbench',     emoji: '🔨', hp: 200, cost: { craft_plank: 5, bar_iron: 1 },      category: 'station' },
    furnace:        { name: 'Furnace',       emoji: '🔥', hp: 250, cost: { ore_gravel: 10, bar_iron: 2 },      category: 'station' },
    storage_box:    { name: 'Storage Box',   emoji: '📦', hp: 100, cost: { craft_plank: 3 },                   category: 'storage' },
    sleeping_bag:   { name: 'Sleeping Bag',  emoji: '🛏️', hp: 50,  cost: { crop_wheat: 5 },                   category: 'spawn' },
    campfire:       { name: 'Burn Barrel',   emoji: '🛢️', hp: 50,  cost: { wood_oak: 5 },                     category: 'comfort' },
    tool_cupboard:  { name: 'Tool Cupboard', emoji: '🧰', hp: 300, cost: { craft_plank: 5, bar_iron: 2 },      category: 'auth' },
};

// ── Rod Tiers (Toontown-style weight limits) ─────────────────
const ROD_TIERS = {
    rod_bamboo:     { tier: 0, maxWeight: 4,  staminaCost: 3, name: 'Bamboo' },
    rod_fiberglass: { tier: 1, maxWeight: 8,  staminaCost: 5, name: 'Fiberglass' },
    rod_carbon:     { tier: 2, maxWeight: 12, staminaCost: 7, name: 'Carbon' },
    rod_titanium:   { tier: 3, maxWeight: 16, staminaCost: 9, name: 'Titanium' },
    rod_mythril:    { tier: 4, maxWeight: 20, staminaCost: 12, name: 'Mythril' },
};

// ── Fish Species Catalog (Toontown-inspired) ─────────────────
// Each species: family, weight range (lbs), min rod tier, which zones, rarity weight for loot tables
const FISH_SPECIES = {
    // — Minnow Family (Tier 0) —
    fish_minnow:       { family: 'Minnow',    minW: 0.5, maxW: 2,  rodTier: 0, zones: ['shallow','river'],         rarityWeight: 30 },
    fish_sunfish:      { family: 'Minnow',    minW: 1,   maxW: 3,  rodTier: 0, zones: ['shallow','river'],         rarityWeight: 25 },
    // — Bass Family (Tier 0) —
    fish_bass:         { family: 'Bass',       minW: 1,   maxW: 4,  rodTier: 0, zones: ['shallow','river','deep'],  rarityWeight: 28 },
    fish_perch:        { family: 'Bass',       minW: 1,   maxW: 3,  rodTier: 0, zones: ['shallow','river'],         rarityWeight: 26 },
    // — Trout Family (Tier 0) —
    fish_trout:        { family: 'Trout',      minW: 1,   maxW: 4,  rodTier: 0, zones: ['shallow','river','arctic'],rarityWeight: 24 },
    fish_clownfish:    { family: 'Trout',      minW: 0.5, maxW: 2,  rodTier: 0, zones: ['shallow'],                 rarityWeight: 20 },
    // — Catfish Family (Tier 1) —
    fish_catfish:      { family: 'Catfish',    minW: 3,   maxW: 7,  rodTier: 1, zones: ['river','deep'],            rarityWeight: 18 },
    fish_carp:         { family: 'Catfish',    minW: 3,   maxW: 6,  rodTier: 1, zones: ['river'],                   rarityWeight: 20 },
    fish_pike:         { family: 'Catfish',    minW: 4,   maxW: 8,  rodTier: 1, zones: ['river','deep'],            rarityWeight: 14 },
    // — Salmon Family (Tier 1) —
    fish_salmon:       { family: 'Salmon',     minW: 3,   maxW: 7,  rodTier: 1, zones: ['river','deep','arctic'],   rarityWeight: 18 },
    fish_rainbow_trout:{ family: 'Salmon',     minW: 4,   maxW: 8,  rodTier: 1, zones: ['river','arctic'],          rarityWeight: 14 },
    fish_king_salmon:  { family: 'Salmon',     minW: 5,   maxW: 8,  rodTier: 1, zones: ['arctic'],                  rarityWeight: 8 },
    // — Puffer Family (Tier 1) —
    fish_pufferfish:   { family: 'Puffer',     minW: 2,   maxW: 5,  rodTier: 1, zones: ['shallow','deep'],          rarityWeight: 16 },
    fish_jellyfish:    { family: 'Puffer',     minW: 2,   maxW: 6,  rodTier: 1, zones: ['deep'],                    rarityWeight: 14 },
    // — Eel Family (Tier 2) —
    fish_electric_eel: { family: 'Eel',        minW: 5,   maxW: 10, rodTier: 2, zones: ['river','deep'],            rarityWeight: 10 },
    fish_stingray:     { family: 'Eel',        minW: 5,   maxW: 9,  rodTier: 2, zones: ['shallow','deep'],          rarityWeight: 12 },
    // — Swordfish Family (Tier 2) —
    fish_swordfish:    { family: 'Swordfish',  minW: 6,   maxW: 11, rodTier: 2, zones: ['deep'],                    rarityWeight: 10 },
    fish_marlin:       { family: 'Swordfish',  minW: 7,   maxW: 12, rodTier: 2, zones: ['deep'],                    rarityWeight: 8 },
    fish_barracuda:    { family: 'Swordfish',  minW: 6,   maxW: 10, rodTier: 2, zones: ['deep','arctic'],           rarityWeight: 10 },
    // — Deep Sea Family (Tier 2) —
    fish_anglerfish:   { family: 'DeepSea',    minW: 5,   maxW: 10, rodTier: 2, zones: ['deep'],                    rarityWeight: 9 },
    fish_octopus:      { family: 'DeepSea',    minW: 6,   maxW: 12, rodTier: 2, zones: ['deep'],                    rarityWeight: 8 },
    // — Shark Family (Tier 3) —
    fish_shark:        { family: 'Shark',      minW: 10,  maxW: 15, rodTier: 3, zones: ['deep'],                    rarityWeight: 5 },
    fish_hammerhead:   { family: 'Shark',      minW: 12,  maxW: 16, rodTier: 3, zones: ['deep'],                    rarityWeight: 4 },
    fish_ghost_fish:   { family: 'Shark',      minW: 10,  maxW: 14, rodTier: 3, zones: ['arctic'],                  rarityWeight: 5 },
    // — Whale Family (Tier 3) —
    fish_whale:        { family: 'Whale',      minW: 12,  maxW: 16, rodTier: 3, zones: ['deep','arctic'],           rarityWeight: 4 },
    fish_narwhal:      { family: 'Whale',      minW: 13,  maxW: 16, rodTier: 3, zones: ['arctic'],                  rarityWeight: 3 },
    // — Legendary Family (Tier 4) —
    fish_kraken:       { family: 'Legendary',  minW: 15,  maxW: 19, rodTier: 4, zones: ['deep'],                    rarityWeight: 2 },
    fish_golden:       { family: 'Legendary',  minW: 16,  maxW: 20, rodTier: 4, zones: ['arctic'],                  rarityWeight: 2 },
    fish_leviathan:    { family: 'Legendary',  minW: 18,  maxW: 20, rodTier: 4, zones: ['deep'],                    rarityWeight: 1 },
};

// Junk items in fishing (always available regardless of rod)
const FISH_JUNK = [
    { id: 'fish_boot',    weight: 10 },
    { id: 'fish_tin_can', weight: 8 },
];

// Build zone loot tables dynamically from FISH_SPECIES + rod tier
function buildFishTable(zone, rodTier) {
    const table = [];
    for (const [fishId, spec] of Object.entries(FISH_SPECIES)) {
        if (spec.rodTier > rodTier) continue;
        if (!spec.zones.includes(zone)) continue;
        table.push({ id: fishId, weight: spec.rarityWeight });
    }
    // Add junk (reduced by rod tier)
    const junkMult = Math.max(0.2, 1 - rodTier * 0.18);
    for (const junk of FISH_JUNK) {
        table.push({ id: junk.id, weight: Math.max(1, Math.round(junk.weight * junkMult)) });
    }
    return table;
}

// ── Loot Tables by Difficulty Tier ───────────────────────────
const WOOD_TABLES = [
    // Tier 0: easy (near outpost)
    [{ id: 'wood_twig', weight: 20 }, { id: 'wood_oak', weight: 45 }, { id: 'wood_maple', weight: 25 }, { id: 'wood_sap', weight: 10 }],
    // Tier 1: medium
    [{ id: 'wood_oak', weight: 15 }, { id: 'wood_maple', weight: 25 }, { id: 'wood_birch', weight: 25 }, { id: 'wood_mahogany', weight: 20 }, { id: 'wood_sap', weight: 10 }, { id: 'wood_yew', weight: 5 }],
    // Tier 2: hard
    [{ id: 'wood_mahogany', weight: 15 }, { id: 'wood_yew', weight: 25 }, { id: 'wood_elder', weight: 25 }, { id: 'wood_sap', weight: 10 }, { id: 'wood_crystal', weight: 10 }, { id: 'loot_crown', weight: 3 }],
    // Tier 3: brutal (map edges)
    [{ id: 'wood_elder', weight: 25 }, { id: 'wood_crystal', weight: 25 }, { id: 'wood_spirit', weight: 8 }, { id: 'wood_yew', weight: 15 }, { id: 'loot_egg', weight: 2 }, { id: 'loot_star', weight: 1 }],
];

const MINE_TABLES = [
    [{ id: 'ore_gravel', weight: 30 }, { id: 'ore_coal', weight: 30 }, { id: 'ore_copper', weight: 20 }, { id: 'ore_iron', weight: 15 }, { id: 'gem_ruby', weight: 4 }, { id: 'loot_coin_pouch', weight: 1 }],
    [{ id: 'ore_coal', weight: 15 }, { id: 'ore_iron', weight: 25 }, { id: 'ore_gold', weight: 20 }, { id: 'gem_ruby', weight: 10 }, { id: 'gem_emerald', weight: 8 }, { id: 'ore_mithril', weight: 5 }, { id: 'gem_diamond', weight: 3 }],
    [{ id: 'ore_gold', weight: 15 }, { id: 'ore_mithril', weight: 20 }, { id: 'ore_titanium', weight: 15 }, { id: 'gem_emerald', weight: 12 }, { id: 'gem_diamond', weight: 10 }, { id: 'ore_platinum', weight: 8 }, { id: 'gem_star', weight: 5 }],
    [{ id: 'ore_titanium', weight: 15 }, { id: 'ore_platinum', weight: 20 }, { id: 'gem_diamond', weight: 15 }, { id: 'gem_star', weight: 12 }, { id: 'ore_dragonite', weight: 10 }, { id: 'mine_void_stone', weight: 5 }, { id: 'loot_void_heart', weight: 1 }],
];

const FISH_TABLES = [
    // Legacy tier tables — rebuilt from FISH_SPECIES for gather() compat
    buildFishTable('shallow', 0),
    buildFishTable('river', 1),
    buildFishTable('deep', 2),
    buildFishTable('deep', 4),
];

// Water zone fish tables — now dynamically built per rod tier at catch time
// These static tables are kept as the default (tier-0 rod) for backward compat
const WATER_ZONE_TABLES = {
    shallow: buildFishTable('shallow', 0),
    river:   buildFishTable('river', 0),
    deep:    buildFishTable('deep', 0),
    arctic:  buildFishTable('arctic', 0),
};

function getWaterZone(tx, ty, seed) {
    // Check neighboring tiles to determine water zone type
    let hasSnow = false, hasSand = false, hasLand = false, waterCount = 0;
    for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            if (dx === 0 && dy === 0) continue;
            const b = getBiomeAt(tx + dx, ty + dy, seed);
            if (b === 'snow') hasSnow = true;
            if (b === 'sand') hasSand = true;
            if (b !== 'water') hasLand = true;
            else waterCount++;
        }
    }
    if (hasSnow) return 'arctic';
    if (hasSand && hasLand) return 'shallow';
    if (hasLand && waterCount <= 16) return 'river';
    return 'deep';
}

// ── Crops ────────────────────────────────────────────────────
const CROPS = {
    seed_wheat:   { growTime: 30 * 60000,  output: 'crop_wheat',   yield: [1, 3], mutation: null },
    seed_carrot:  { growTime: 45 * 60000,  output: 'crop_carrot',  yield: [1, 3], mutation: null },
    seed_tomato:  { growTime: 60 * 60000,  output: 'crop_tomato',  yield: [1, 2], mutation: null },
    seed_corn:    { growTime: 90 * 60000,  output: 'crop_corn',    yield: [1, 2], mutation: null },
    seed_pumpkin: { growTime: 120 * 60000, output: 'crop_pumpkin', yield: [1, 2], mutation: null },
    seed_golden:  { growTime: 180 * 60000, output: 'crop_golden',  yield: [1, 1], mutation: null },
};

// ── Monsters ─────────────────────────────────────────────────
const MONSTERS = [
    { name: 'Rat',          emoji: '🐀', hp: 20,  atk: 3,  def: 1,  xp: 10,  gold: 5,     loot: [{ id: 'loot_lint', w: 80 }, { id: 'loot_coin_pouch', w: 20 }] },
    { name: 'Skeleton',     emoji: '💀', hp: 40,  atk: 8,  def: 3,  xp: 25,  gold: 12,    loot: [{ id: 'loot_coin_pouch', w: 50 }, { id: 'weapon_stick', w: 30 }, { id: 'loot_feather', w: 20 }] },
    { name: 'Spider',       emoji: '🕷️', hp: 35,  atk: 10, def: 2,  xp: 20,  gold: 10,   loot: [{ id: 'bait_worm', w: 40 }, { id: 'loot_feather', w: 40 }, { id: 'loot_crown', w: 20 }] },
    { name: 'Goblin',       emoji: '👺', hp: 50,  atk: 12, def: 5,  xp: 35,  gold: 20,    loot: [{ id: 'loot_coin_pouch', w: 40 }, { id: 'ore_gold', w: 30 }, { id: 'loot_crown', w: 30 }] },
    { name: 'Slime King',   emoji: '🟢', hp: 80,  atk: 6,  def: 10, xp: 50,  gold: 30,    loot: [{ id: 'gem_emerald', w: 30 }, { id: 'loot_egg', w: 20 }, { id: 'hat_cowboy', w: 5 }] },
    { name: 'Dark Knight',  emoji: '🗡️', hp: 100, atk: 18, def: 12, xp: 75,  gold: 45,   loot: [{ id: 'weapon_sword', w: 20 }, { id: 'armor_chain', w: 15 }, { id: 'gem_diamond', w: 25 }] },
    { name: 'Fire Elemental',emoji:'🔥', hp: 120, atk: 22, def: 8,  xp: 90,  gold: 55,    loot: [{ id: 'gem_ruby', w: 25 }, { id: 'bar_gold', w: 20 }, { id: 'hat_wizard', w: 5 }] },
    { name: 'Dragon',       emoji: '🐉', hp: 250, atk: 35, def: 25, xp: 200, gold: 150,   loot: [{ id: 'ore_dragonite', w: 20 }, { id: 'weapon_katana', w: 10 }, { id: 'armor_dragonscale', w: 5 }, { id: 'weapon_legendary', w: 2 }] },
    { name: 'Void Wraith',  emoji: '👻', hp: 300, atk: 40, def: 30, xp: 300, gold: 200,   loot: [{ id: 'mine_void_stone', w: 15 }, { id: 'hat_void_crown', w: 3 }, { id: 'loot_void_heart', w: 5 }] },
];

// ── Recipes ──────────────────────────────────────────────────
const RECIPES = {
    // Starter tool crafting (fist → stone tier)
    pick_wood:      { name: 'Wooden Pickaxe',  inputs: { raw_stick: 3, raw_stone: 2 },         output: 'pick_wood',   qty: 1, rarity: 'Common',    xp: 5 },
    pick_stone:     { name: 'Stone Pickaxe',   inputs: { raw_stone: 5, raw_stick: 2, raw_flint: 1 }, output: 'pick_stone', qty: 1, rarity: 'Common', xp: 10 },
    axe_stone:      { name: 'Stone Axe',       inputs: { raw_stone: 3, raw_stick: 2 },         output: 'axe_stone',   qty: 1, rarity: 'Common',    xp: 5 },
    weapon_rock:    { name: 'Sharp Rock',      inputs: { raw_stone: 2, raw_flint: 1 },         output: 'weapon_rock', qty: 1, rarity: 'Junk',      xp: 3 },
    rod_bamboo:     { name: 'Bamboo Rod',      inputs: { raw_stick: 3, bait_worm: 1 },         output: 'rod_bamboo',  qty: 1, rarity: 'Common',    xp: 5 },
    craft_plank:    { name: 'Wooden Plank',    inputs: { wood_oak: 2 },                     output: 'craft_plank',    qty: 3, rarity: 'Common',    xp: 10 },
    craft_charcoal: { name: 'Charcoal',        inputs: { wood_oak: 1, ore_coal: 1 },        output: 'craft_charcoal', qty: 2, rarity: 'Common',    xp: 15 },
    craft_arrow:    { name: 'Arrows',          inputs: { craft_plank: 1, ore_iron: 1 },     output: 'craft_arrow',    qty: 1, rarity: 'Uncommon',  xp: 25 },
    craft_shield:   { name: 'Wooden Shield',   inputs: { craft_plank: 3, bar_iron: 1 },     output: 'craft_shield',   qty: 1, rarity: 'Uncommon',  xp: 30 },
    craft_totem:    { name: 'Spirit Totem',    inputs: { wood_elder: 2, gem_ruby: 1 },       output: 'craft_totem',    qty: 1, rarity: 'Rare',      xp: 60 },
    craft_wand:     { name: 'Crystal Wand',    inputs: { wood_crystal: 1, gem_diamond: 1 },  output: 'craft_wand',     qty: 1, rarity: 'Epic',      xp: 100 },
    craft_crown:    { name: 'Crown of Thorns', inputs: { bar_gold: 2, gem_emerald: 1 },      output: 'craft_crown',    qty: 1, rarity: 'Epic',      xp: 120 },
    craft_golem:    { name: 'Iron Golem Core', inputs: { bar_iron: 5, gem_ruby: 2 },         output: 'craft_golem',    qty: 1, rarity: 'Epic',      xp: 150 },
    // ── Smelting (requires furnace station nearby) ──
    bar_bronze:     { name: 'Smelt Bronze',    inputs: { ore_tin: 1, ore_copper: 1 },        output: 'bar_bronze',     qty: 1, rarity: 'Common',    xp: 12, skill: 'smithing', station: 'furnace' },
    bar_copper:     { name: 'Smelt Copper',    inputs: { ore_copper: 2 },                    output: 'bar_copper',     qty: 1, rarity: 'Common',    xp: 10, skill: 'smithing', station: 'furnace' },
    bar_iron:       { name: 'Smelt Iron',      inputs: { ore_iron: 2, ore_coal: 1 },         output: 'bar_iron',       qty: 1, rarity: 'Common',    xp: 20, skill: 'smithing', station: 'furnace', smithingLevel: 5 },
    bar_steel:      { name: 'Smelt Steel',     inputs: { ore_iron: 1, ore_coal: 2 },         output: 'bar_steel',      qty: 1, rarity: 'Uncommon',  xp: 35, skill: 'smithing', station: 'furnace', smithingLevel: 15 },
    bar_gold:       { name: 'Smelt Gold',      inputs: { ore_gold: 2, craft_charcoal: 1 },   output: 'bar_gold',       qty: 1, rarity: 'Uncommon',  xp: 35, skill: 'smithing', station: 'furnace', smithingLevel: 10 },
    bar_mithril:    { name: 'Smelt Mithril',   inputs: { ore_mithril: 2, craft_charcoal: 2 },output: 'bar_mithril',    qty: 1, rarity: 'Rare',      xp: 60, skill: 'smithing', station: 'furnace', smithingLevel: 25 },
    bar_titanium:   { name: 'Smelt Titanium',  inputs: { ore_titanium: 3, craft_charcoal: 2 },output:'bar_titanium',   qty: 1, rarity: 'Rare',      xp: 80, skill: 'smithing', station: 'furnace', smithingLevel: 35 },
    bar_platinum:   { name: 'Smelt Platinum',  inputs: { ore_platinum: 3, craft_charcoal: 3 },output:'bar_platinum',   qty: 1, rarity: 'Epic',      xp: 100, skill: 'smithing', station: 'furnace', smithingLevel: 45 },
    bar_dragonite:  { name: 'Smelt Dragonite', inputs: { ore_dragonite: 3, gem_star: 1 },    output: 'bar_dragonite',  qty: 1, rarity: 'Legendary', xp: 200, skill: 'smithing', station: 'furnace', smithingLevel: 55 },
    // ── Smithing at Workbench (bars → tools/weapons) ──
    pick_iron:      { name: 'Iron Pickaxe',     inputs: { bar_iron: 3, raw_stick: 2 },        output: 'pick_iron',      qty: 1, rarity: 'Uncommon',  xp: 30, skill: 'smithing', station: 'workbench', smithingLevel: 8 },
    pick_gold:      { name: 'Gold Pickaxe',     inputs: { bar_gold: 3, wood_yew: 1 },         output: 'pick_gold',      qty: 1, rarity: 'Rare',      xp: 50, skill: 'smithing', station: 'workbench', smithingLevel: 20 },
    pick_diamond:   { name: 'Diamond Pickaxe',  inputs: { bar_titanium: 2, gem_diamond: 2 },   output: 'pick_diamond',   qty: 1, rarity: 'Epic',      xp: 100, skill: 'smithing', station: 'workbench', smithingLevel: 35 },
    axe_iron:       { name: 'Iron Axe',          inputs: { bar_iron: 3, raw_stick: 2 },         output: 'axe_iron',       qty: 1, rarity: 'Uncommon',  xp: 30, skill: 'smithing', station: 'workbench', smithingLevel: 8 },
    axe_steel:      { name: 'Steel Axe',         inputs: { bar_steel: 3, wood_mahogany: 1 },    output: 'axe_steel',      qty: 1, rarity: 'Rare',      xp: 50, skill: 'smithing', station: 'workbench', smithingLevel: 18 },
    axe_mythril:    { name: 'Mythril Axe',       inputs: { bar_mithril: 3, wood_elder: 1 },     output: 'axe_mythril',    qty: 1, rarity: 'Epic',      xp: 80, skill: 'smithing', station: 'workbench', smithingLevel: 30 },
    compost:        { name: 'Compost',         inputs: { crop_wheat: 2, wood_twig: 3 },      output: 'compost',        qty: 2, rarity: 'Common',    xp: 10 },
    craft_elixir:   { name: 'Elixir of Fortune',inputs:{ gem_ruby: 1, crop_tomato: 2 },     output: 'craft_elixir',   qty: 1, rarity: 'Uncommon',  xp: 40 },
    craft_xp_potion:{ name: 'XP Boost Potion', inputs: { gem_emerald: 1, wood_sap: 2 },     output: 'craft_xp_potion',qty: 1, rarity: 'Uncommon',  xp: 40 },
    fish_sonar:     { name: 'Fish Sonar',       inputs: { ore_copper: 2, gem_ruby: 1 },       output: 'fish_sonar',     qty: 1, rarity: 'Uncommon',  xp: 30 },
    hat_cowboy:     { name: 'Cowboy Hat',       inputs: { crop_wheat: 5, wood_oak: 2 },      output: 'hat_cowboy',     qty: 1, rarity: 'Uncommon',  xp: 35 },
    hat_wizard:     { name: 'Wizard Hat',       inputs: { wood_elder: 2, gem_ruby: 1 },      output: 'hat_wizard',     qty: 1, rarity: 'Rare',      xp: 75 },
    hat_crown:      { name: 'Royal Crown',      inputs: { bar_gold: 3, gem_diamond: 2 },    output: 'hat_crown',      qty: 1, rarity: 'Epic',      xp: 150 },
    potion_health:  { name: 'Health Potion',    inputs: { crop_tomato: 1, wood_sap: 1 },    output: 'potion_health',  qty: 2, rarity: 'Common',    xp: 15 },
    // ── Cooking (requires a burn barrel station nearby) ──
    food_cooked_fish:  { name: 'Cooked Fish',     inputs: { fish_bass: 1, wood_oak: 1 },              output: 'food_cooked_fish',  qty: 2, rarity: 'Common',   xp: 10, skill: 'cooking', station: 'campfire' },
    food_grilled_meat: { name: 'Grilled Meat',    inputs: { fish_catfish: 1, raw_stick: 2 },           output: 'food_grilled_meat', qty: 1, rarity: 'Common',   xp: 15, skill: 'cooking', station: 'campfire' },
    food_trail_mix:    { name: 'Trail Mix',       inputs: { crop_wheat: 2, crop_corn: 1, wood_sap: 1 },output: 'food_trail_mix',    qty: 2, rarity: 'Common',   xp: 15, skill: 'cooking' },
    food_veggie_soup:  { name: 'Veggie Soup',     inputs: { crop_carrot: 2, crop_tomato: 1, crop_wheat: 1 }, output: 'food_veggie_soup', qty: 1, rarity: 'Uncommon', xp: 25, skill: 'cooking', station: 'campfire' },
    food_fish_stew:    { name: 'Fish Stew',       inputs: { fish_salmon: 1, crop_tomato: 1, crop_carrot: 1 }, output: 'food_fish_stew',  qty: 1, rarity: 'Uncommon', xp: 30, skill: 'cooking', station: 'campfire' },
    food_energy_bar:   { name: 'Energy Bar',      inputs: { crop_corn: 2, crop_wheat: 2, wood_sap: 1 },output: 'food_energy_bar',   qty: 2, rarity: 'Uncommon', xp: 25, skill: 'cooking' },
    food_pumpkin_pie:  { name: 'Pumpkin Pie',     inputs: { crop_pumpkin: 1, crop_wheat: 2, crop_golden: 1 }, output: 'food_pumpkin_pie', qty: 1, rarity: 'Rare', xp: 60, skill: 'cooking', station: 'campfire' },
    food_golden_feast: { name: 'Golden Feast',    inputs: { crop_golden: 1, fish_king_salmon: 1, bar_gold: 1 }, output: 'food_golden_feast', qty: 1, rarity: 'Epic', xp: 100, skill: 'cooking', station: 'campfire' },
    // Weapons & Armor (smithing at workbench)
    weapon_sword:   { name: 'Iron Sword',       inputs: { bar_iron: 3 },                      output: 'weapon_sword',   qty: 1, rarity: 'Uncommon',  xp: 40, skill: 'smithing', station: 'workbench', smithingLevel: 10 },
    weapon_axe:     { name: 'Battle Axe',       inputs: { bar_steel: 3, wood_elder: 1 },      output: 'weapon_axe',     qty: 1, rarity: 'Rare',      xp: 80, skill: 'smithing', station: 'workbench', smithingLevel: 22 },
    weapon_katana:  { name: 'Shadow Katana',    inputs: { bar_titanium: 2, gem_diamond: 1 },   output: 'weapon_katana',  qty: 1, rarity: 'Epic',      xp: 150, skill: 'smithing', station: 'workbench', smithingLevel: 40 },
    armor_leather:  { name: 'Leather Armor',    inputs: { crop_wheat: 5, bar_iron: 1 },        output: 'armor_leather',  qty: 1, rarity: 'Uncommon',  xp: 35, station: 'workbench' },
    armor_chain:    { name: 'Chainmail',        inputs: { bar_iron: 4, ore_coal: 2 },          output: 'armor_chain',    qty: 1, rarity: 'Rare',      xp: 70, skill: 'smithing', station: 'workbench', smithingLevel: 15 },
    armor_plate:    { name: 'Plate Armor',      inputs: { bar_titanium: 2, bar_gold: 1 },      output: 'armor_plate',    qty: 1, rarity: 'Epic',      xp: 130, skill: 'smithing', station: 'workbench', smithingLevel: 35 },
};

// ── NPCs (Town Layout — buildings are 3w×4h, door at bottom-center) ──
// Center = OUTPOST_X,OUTPOST_Y. Town radius 14 tiles. Buildings spaced around a central square.
// Each NPC stands 1 tile inside their door (tileX/Y = door tile, which is the interaction point).
// buildTiles = full footprint (walls + floor), doorTile = entrance tile.

function makeBuildTiles(cx, cy) {
    // 3×4 building centered at cx, top row cy-2, bottom row cy+1
    const tiles = [];
    for (let dy = -2; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            tiles.push([cx + dx, cy + dy]);
        }
    }
    return tiles;
}

const OX = OUTPOST_X, OY = OUTPOST_Y;
const NPCS = {
    banker:      { id: 'banker',      name: 'Banker',        emoji: '🏦', tileX: OX,     tileY: OY - 4, doorTile: [OX, OY - 3],       buildTiles: makeBuildTiles(OX, OY - 4),       roofColor: '#4a6741', categories: [] },
    weaponsmith: { id: 'weaponsmith', name: 'Weaponsmith',   emoji: '⚔️', tileX: OX - 7, tileY: OY - 4, doorTile: [OX - 7, OY - 3],   buildTiles: makeBuildTiles(OX - 7, OY - 4),   roofColor: '#8b3a3a', categories: ['weapons', 'armor'] },
    toolshop:    { id: 'toolshop',    name: 'Tool Merchant', emoji: '🧰', tileX: OX - 7, tileY: OY + 1, doorTile: [OX - 7, OY + 2],   buildTiles: makeBuildTiles(OX - 7, OY + 1),   roofColor: '#5a4a3a', categories: ['pickaxes', 'axes', 'rods', 'tools'] },
    farmsupply:  { id: 'farmsupply',  name: 'Farm Supply',   emoji: '🌱', tileX: OX + 7, tileY: OY - 4, doorTile: [OX + 7, OY - 3],   buildTiles: makeBuildTiles(OX + 7, OY - 4),   roofColor: '#5a7a3a', categories: ['seeds', 'bait', 'consumable'] },
    gemtrader:   { id: 'gemtrader',   name: 'Gem Trader',    emoji: '💎', tileX: OX + 7, tileY: OY + 1, doorTile: [OX + 7, OY + 2],   buildTiles: makeBuildTiles(OX + 7, OY + 1),   roofColor: '#4a3a6a', categories: ['ores', 'gems', 'bars'] },
    cosmetics:   { id: 'cosmetics',   name: 'Cosmetics',     emoji: '🎩', tileX: OX,     tileY: OY + 4, doorTile: [OX, OY + 5],       buildTiles: makeBuildTiles(OX, OY + 4),       roofColor: '#8a5a8a', categories: ['hats', 'name_effects', 'particles', 'voices'] },
    cook:        { id: 'cook',        name: 'Camp Chef',     emoji: '👨‍🍳', tileX: OX - 11,tileY: OY - 2, doorTile: [OX - 11, OY - 1], buildTiles: makeBuildTiles(OX - 11, OY - 2), roofColor: '#7a5a3a', categories: ['food', 'consumable'] },
    tagmaster:   { id: 'tagmaster',   name: 'Tag Master',    emoji: '🏷️', tileX: OX + 11,tileY: OY - 2, doorTile: [OX + 11, OY - 1], buildTiles: makeBuildTiles(OX + 11, OY - 2), roofColor: '#4a5a7a', categories: ['tags'], guardedBy: 'tag_guardian' },
};

// Village NPC generation — each village gets 2 shopkeepers
(function generateVillageNPCs() {
    const villageDefs = [
        { village: VILLAGES[0], npcs: [
            { id: 'v_fishmonger', name: 'Fishmonger', emoji: '🐟', ox: -3, oy: -2, roofColor: '#3a6a7a', categories: ['rods', 'bait'] },
            { id: 'v_tavern',     name: 'Tavern Keep', emoji: '🍺', ox: 3,  oy: -2, roofColor: '#6a4a2a', categories: ['food', 'consumable'] },
        ]},
        { village: VILLAGES[1], npcs: [
            { id: 'v_minesmith',  name: 'Mine Smith',  emoji: '⛏️', ox: -3, oy: -2, roofColor: '#5a5a5a', categories: ['pickaxes', 'ores', 'bars'] },
            { id: 'v_armorsmith', name: 'Armorsmith',  emoji: '🛡️', ox: 3,  oy: -2, roofColor: '#7a3a3a', categories: ['armor', 'weapons'] },
        ]},
        { village: VILLAGES[2], npcs: [
            { id: 'v_herbalist',  name: 'Herbalist',   emoji: '🌿', ox: -3, oy: -2, roofColor: '#3a7a3a', categories: ['seeds', 'consumable'] },
            { id: 'v_woodsman',   name: 'Woodsman',    emoji: '🪵', ox: 3,  oy: -2, roofColor: '#5a3a2a', categories: ['axes', 'tools'] },
        ]},
    ];
    for (const vd of villageDefs) {
        for (const n of vd.npcs) {
            const tx = vd.village.cx + n.ox;
            const ty = vd.village.cy + n.oy;
            NPCS[n.id] = {
                id: n.id, name: n.name, emoji: n.emoji,
                tileX: tx, tileY: ty,
                doorTile: [tx, ty + 1],
                buildTiles: makeBuildTiles(tx, ty),
                roofColor: n.roofColor,
                categories: n.categories,
                village: vd.village.id,
            };
        }
    }
})();

// ── Town Decorations (rendered on client, defined here for shared access) ──
const TOWN_DECO = [
    // ─ Main Town ─
    { type: 'fountain', tileX: OX, tileY: OY, emoji: '⛲' },
    // Lampposts along main paths
    { type: 'lamp', tileX: OX - 3, tileY: OY - 2 }, { type: 'lamp', tileX: OX + 3, tileY: OY - 2 },
    { type: 'lamp', tileX: OX - 3, tileY: OY + 2 }, { type: 'lamp', tileX: OX + 3, tileY: OY + 2 },
    { type: 'lamp', tileX: OX - 9, tileY: OY },     { type: 'lamp', tileX: OX + 9, tileY: OY },
    { type: 'lamp', tileX: OX, tileY: OY - 8 },     { type: 'lamp', tileX: OX, tileY: OY + 8 },
    // Benches near the square
    { type: 'bench', tileX: OX - 2, tileY: OY - 1 }, { type: 'bench', tileX: OX + 2, tileY: OY - 1 },
    { type: 'bench', tileX: OX - 2, tileY: OY + 1 }, { type: 'bench', tileX: OX + 2, tileY: OY + 1 },
    // Flower beds
    { type: 'flowers', tileX: OX - 1, tileY: OY - 1 }, { type: 'flowers', tileX: OX + 1, tileY: OY - 1 },
    { type: 'flowers', tileX: OX - 1, tileY: OY + 1 }, { type: 'flowers', tileX: OX + 1, tileY: OY + 1 },
    // Sign posts at town entrances
    { type: 'sign', tileX: OX, tileY: OY - OUTPOST_RADIUS + 3, text: 'Town' },
    { type: 'sign', tileX: OX, tileY: OY + OUTPOST_RADIUS - 3, text: 'Town' },
    { type: 'sign', tileX: OX - OUTPOST_RADIUS + 3, tileY: OY, text: 'Town' },
    { type: 'sign', tileX: OX + OUTPOST_RADIUS - 3, tileY: OY, text: 'Town' },
    // Decorative trees
    { type: 'town_tree', tileX: OX - 10, tileY: OY - 8 }, { type: 'town_tree', tileX: OX + 10, tileY: OY - 8 },
    { type: 'town_tree', tileX: OX - 10, tileY: OY + 8 }, { type: 'town_tree', tileX: OX + 10, tileY: OY + 8 },
    { type: 'town_tree', tileX: OX - 5, tileY: OY - 9 },  { type: 'town_tree', tileX: OX + 5, tileY: OY - 9 },
    { type: 'town_tree', tileX: OX - 5, tileY: OY + 9 },  { type: 'town_tree', tileX: OX + 5, tileY: OY + 9 },
    // Crates & barrels near shops
    { type: 'barrel', tileX: OX - 9, tileY: OY - 6 }, { type: 'barrel', tileX: OX - 5, tileY: OY - 6 },
    { type: 'crate', tileX: OX + 9, tileY: OY - 6 },  { type: 'crate', tileX: OX + 5, tileY: OY - 6 },
    { type: 'barrel', tileX: OX - 9, tileY: OY + 2 }, { type: 'crate', tileX: OX + 9, tileY: OY + 2 },
    { type: 'well', tileX: OX - 2, tileY: OY - 7 },
    // Tag Master building — guardian stands outside
    { type: 'lamp', tileX: OX + 9, tileY: OY },
    { type: 'sign', tileX: OX + 11, tileY: OY, text: 'Tag Master' },
];
// Add village decorations
for (const v of VILLAGES) {
    TOWN_DECO.push(
        { type: 'fountain', tileX: v.cx, tileY: v.cy, emoji: '⛲' },
        { type: 'lamp', tileX: v.cx - 3, tileY: v.cy - 1 },
        { type: 'lamp', tileX: v.cx + 3, tileY: v.cy - 1 },
        { type: 'lamp', tileX: v.cx - 3, tileY: v.cy + 1 },
        { type: 'lamp', tileX: v.cx + 3, tileY: v.cy + 1 },
        { type: 'bench', tileX: v.cx - 1, tileY: v.cy + 1 },
        { type: 'bench', tileX: v.cx + 1, tileY: v.cy + 1 },
        { type: 'sign', tileX: v.cx, tileY: v.cy + v.radius - 1, text: v.name },
        { type: 'sign', tileX: v.cx, tileY: v.cy - v.radius + 1, text: v.name },
        { type: 'town_tree', tileX: v.cx - 5, tileY: v.cy - 4 },
        { type: 'town_tree', tileX: v.cx + 5, tileY: v.cy - 4 },
    );
}

// ── Town Path Tiles — roads/cobblestone (set of "tileX,tileY" strings) ──
function generateTownPaths() {
    const paths = new Set();
    const cx = OX, cy = OY;

    // Collect all NPC building tiles to exclude from paths
    const buildingTiles = new Set();
    for (const npc of Object.values(NPCS)) {
        for (const [bx, by] of (npc.buildTiles || [])) buildingTiles.add(`${bx},${by}`);
    }
    const addPath = (x, y) => {
        const k = `${x},${y}`;
        if (!buildingTiles.has(k)) paths.add(k);
    };

    // ─ Main Town paths ─
    // North-south road (3 tiles wide)
    for (let y = cy - OUTPOST_RADIUS + 2; y <= cy + OUTPOST_RADIUS - 2; y++) {
        addPath(cx - 1, y); addPath(cx, y); addPath(cx + 1, y);
    }
    // East-west road (3 tiles wide)
    for (let x = cx - OUTPOST_RADIUS + 2; x <= cx + OUTPOST_RADIUS - 2; x++) {
        addPath(x, cy - 1); addPath(x, cy); addPath(x, cy + 1);
    }
    // Town square (5×5 around fountain)
    for (let x = cx - 2; x <= cx + 2; x++) {
        for (let y = cy - 2; y <= cy + 2; y++) {
            addPath(x, y);
        }
    }
    // Side paths to each building (2 tiles wide leading to doors)
    // NW weaponsmith
    for (let x = cx - 6; x <= cx - 2; x++) { addPath(x, cy - 3); addPath(x, cy - 2); }
    // NE farm supply
    for (let x = cx + 2; x <= cx + 6; x++) { addPath(x, cy - 3); addPath(x, cy - 2); }
    // SW tool shop
    for (let x = cx - 6; x <= cx - 2; x++) { addPath(x, cy + 2); addPath(x, cy + 3); }
    // SE gem trader
    for (let x = cx + 2; x <= cx + 6; x++) { addPath(x, cy + 2); addPath(x, cy + 3); }
    // S cosmetics
    for (let y = cy + 2; y <= cy + 6; y++) { addPath(cx - 1, y); addPath(cx, y); addPath(cx + 1, y); }
    // W cook
    for (let x = cx - OUTPOST_RADIUS + 2; x <= cx - 2; x++) { addPath(x, cy - 1); addPath(x, cy); }
    // E tag master
    for (let x = cx + 2; x <= cx + OUTPOST_RADIUS - 2; x++) { addPath(x, cy - 1); addPath(x, cy); }

    // ─ Village internal paths ─
    for (const v of VILLAGES) {
        // Small cross path within each village
        for (let y = v.cy - v.radius + 2; y <= v.cy + v.radius - 2; y++) {
            addPath(v.cx, y); addPath(v.cx - 1, y);
        }
        for (let x = v.cx - v.radius + 2; x <= v.cx + v.radius - 2; x++) {
            addPath(x, v.cy); addPath(x, v.cy - 1);
        }
        // Small square (3×3) around center
        for (let x = v.cx - 1; x <= v.cx + 1; x++) {
            for (let y = v.cy - 1; y <= v.cy + 1; y++) {
                addPath(x, y);
            }
        }
    }

    // ─ Inter-town roads (3-wide Bresenham path from main town to each village) ─
    for (const v of VILLAGES) {
        const steps = Math.max(Math.abs(v.cx - cx), Math.abs(v.cy - cy));
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            const rx = Math.round(cx + (v.cx - cx) * t);
            const ry = Math.round(cy + (v.cy - cy) * t);
            // 3-wide road
            addPath(rx - 1, ry); addPath(rx, ry); addPath(rx + 1, ry);
            addPath(rx, ry - 1); addPath(rx, ry + 1);
        }
    }

    return paths;
}
const TOWN_PATHS = generateTownPaths();
const NPC_LIST = Object.values(NPCS);
const NPC_INTERACT_RANGE = 3;

// ── World Mob Types (roaming enemies in the open world) ─────
const MOB_TYPES = {
    rat:      { name: 'Rat',          emoji: '🐀', hp: 20,  atk: 3,  def: 0,  xp: 10,  gold: 5,   speed: 0.8, aggroRange: 3, biomes: ['grass','forest','sand'], minTier: 0, loot: [{id:'loot_lint',w:50},{id:'bait_worm',w:30},{id:'loot_coin_pouch',w:20}] },
    wolf:     { name: 'Wolf',         emoji: '🐺', hp: 45,  atk: 8,  def: 2,  xp: 25,  gold: 12,  speed: 1.4, aggroRange: 5, biomes: ['forest','hills','grass'], minTier: 0, loot: [{id:'loot_coin_pouch',w:40},{id:'potion_health',w:30},{id:'loot_feather',w:30}] },
    spider:   { name: 'Cave Spider',  emoji: '🕷️', hp: 35, atk: 7,  def: 1,  xp: 20,  gold: 8,   speed: 1.0, aggroRange: 4, biomes: ['hills','mountain','desert'], minTier: 1, loot: [{id:'bait_cricket',w:40},{id:'loot_coin_pouch',w:35},{id:'potion_health',w:25}] },
    skeleton: { name: 'Skeleton',     emoji: '💀', hp: 60,  atk: 12, def: 5,  xp: 40,  gold: 20,  speed: 0.7, aggroRange: 5, biomes: ['mountain','desert','snow'], minTier: 1, loot: [{id:'dungeon_key',w:8},{id:'weapon_stick',w:22},{id:'loot_coin_pouch',w:40},{id:'loot_feather',w:30}] },
    golem:    { name: 'Stone Golem',  emoji: '🗿', hp: 100, atk: 18, def: 12, xp: 65,  gold: 35,  speed: 0.4, aggroRange: 4, biomes: ['mountain','hills'], minTier: 2, loot: [{id:'ore_iron',w:25},{id:'ore_gold',w:20},{id:'gem_ruby',w:15},{id:'bar_iron',w:25},{id:'loot_crown',w:15}] },
    wraith:   { name: 'Wraith',       emoji: '👻', hp: 80,  atk: 22, def: 8,  xp: 80,  gold: 45,  speed: 1.3, aggroRange: 6, biomes: ['snow','mountain'], minTier: 2, loot: [{id:'gem_emerald',w:25},{id:'mine_void_stone',w:5},{id:'loot_egg',w:15},{id:'dungeon_key',w:20},{id:'craft_xp_potion',w:35}] },
    dragon:   { name: 'Dragon Whelp', emoji: '🐲', hp: 180, atk: 32, def: 18, xp: 150, gold: 80,  speed: 1.0, aggroRange: 7, biomes: ['mountain','snow'], minTier: 3, loot: [{id:'ore_dragonite',w:15},{id:'gem_diamond',w:25},{id:'loot_egg',w:20},{id:'loot_star',w:10},{id:'dungeon_key',w:30}] },
    // Aggro village guards — patrol near villages, hostile to non-town players
    bandit:   { name: 'Bandit',       emoji: '🗡️', hp: 50,  atk: 10, def: 3,  xp: 30,  gold: 15,  speed: 1.1, aggroRange: 5, biomes: ['grass','forest','sand','hills','desert'], minTier: 0, loot: [{id:'loot_coin_pouch',w:40},{id:'weapon_stick',w:25},{id:'potion_health',w:20},{id:'loot_feather',w:15}], nearVillage: true },
    raider:   { name: 'Raider',       emoji: '⚔️', hp: 75,  atk: 15, def: 6,  xp: 45,  gold: 25,  speed: 1.0, aggroRange: 6, biomes: ['grass','forest','hills','mountain','desert'], minTier: 1, loot: [{id:'loot_coin_pouch',w:35},{id:'bar_iron',w:20},{id:'potion_health',w:25},{id:'dungeon_key',w:10},{id:'loot_crown',w:10}], nearVillage: true },
};

// ── Weapon & Armor Stats (shared with engine) ───────────────
const WEAPON_STATS = {
    weapon_fist:      { atk: 0,  speed: 1.0, range: 1.0 },
    weapon_rock:      { atk: 1,  speed: 1.2, range: 0.8 },
    weapon_stick:     { atk: 2,  speed: 1.3, range: 1.2 },
    weapon_sword:     { atk: 8,  speed: 1.0, range: 1.2 },
    weapon_axe:       { atk: 15, speed: 0.7, range: 1.0 },
    weapon_katana:    { atk: 25, speed: 1.4, range: 1.3 },
    weapon_legendary: { atk: 40, speed: 1.1, range: 1.4 },
};
const ARMOR_STATS = {
    armor_cloth:       { def: 3 },
    armor_leather:     { def: 8 },
    armor_chain:       { def: 15 },
    armor_plate:       { def: 25 },
    armor_dragonscale: { def: 40 },
};

// ── Level Requirements by Category ───────────────────────────
const EQUIP_SKILL_MAP = {
    pickaxes: 'mining', axes: 'woodcut', rods: 'fishing',
    weapons: 'combat', armor: 'combat',
};

// ── Food Effects ─────────────────────────────────────────────
const FOOD_EFFECTS = {
    food_cooked_fish:  { hp: 20 },
    food_grilled_meat: { hp: 30 },
    food_fish_stew:    { hp: 40, buff: { atk: 5, duration: 180000 } },
    food_veggie_soup:  { hp: 25, buff: { def: 5, duration: 180000 } },
    food_trail_mix:    { stamina: 30, buff: { sprint_free: true, duration: 120000 } },
    food_energy_bar:   { stamina: 50, buff: { max_stamina: 20, duration: 300000 } },
    food_pumpkin_pie:  { hp: 50, buff: { xp_mult: 2, duration: 120000 } },
    food_golden_feast: { hp: 75, buff: { atk: 10, def: 10, duration: 300000 } },
    food_campfire_meal:{ hp: 15, buff: { hp_regen: 3, duration: 120000 } },
};

// ── Utility ──────────────────────────────────────────────────
function xpToLevel(xp) { return Math.floor(Math.sqrt(xp / 25)) + 1; }
function levelToXp(level) { return (level - 1) * (level - 1) * 25; }

function rollLoot(table) {
    const total = table.reduce((s, e) => s + (e.weight || e.w || 0), 0);
    let roll = Math.random() * total;
    for (const entry of table) {
        roll -= (entry.weight || entry.w || 0);
        if (roll <= 0) return entry.id;
    }
    return table[table.length - 1].id;
}

module.exports = {
    ITEMS, RARITY_COLORS, RECIPES, STRUCTURES, BIOME_COLORS,
    FISH_TABLES, MINE_TABLES, WOOD_TABLES, WATER_ZONE_TABLES, CROPS, MONSTERS,
    FISH_SPECIES, FISH_JUNK, ROD_TIERS, buildFishTable,
    PICK_TIERS, AXE_TIERS, ORE_NODE_TYPES, getOreNodeType,
    MOB_TYPES, VILLAGES,
    WEAPON_STATS, ARMOR_STATS, EQUIP_SKILL_MAP, FOOD_EFFECTS,
    MAP_W, MAP_H, TILE, OUTPOST_X, OUTPOST_Y, OUTPOST_RADIUS,
    NPCS, NPC_LIST, NPC_INTERACT_RANGE, TOWN_DECO, TOWN_PATHS,
    xpToLevel, levelToXp, rollLoot,
    hashNoise, smoothNoise, fbm, getBiome, getBiomeAt, getWaterZone,
    getResourceNodeAt, getDifficultyTier, isInSafeZone,
};
