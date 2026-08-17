/* ═══════════════════════════════════════════════════════════════
   OpenVibeGame — Client-Side Open-World Survival Game
   Canvas-based renderer, WebSocket multiplayer, Rust-style
   ═══════════════════════════════════════════════════════════════ */

// ── Map / World Constants (must match server items.js) ───────
let MAP_W = 512, MAP_H = 512;
const TILE = 32;
let OUTPOST_X = Math.floor(MAP_W / 2), OUTPOST_Y = Math.floor(MAP_H / 2), OUTPOST_RADIUS = 14;

// Procedural villages — populated from server init message
let VILLAGES = [];

const BIOME_COLORS = {
    water: '#1e40af', sand: '#d4a053', grass: '#22c55e', forest: '#166534',
    desert: '#92400e', hills: '#78716c', mountain: '#44403c', snow: '#cbd5e1',
    outpost: '#7a9a5e',  // grassy town base
};

const RARITY_COLORS = {
    Junk: '#888', Common: '#b0b0b0', Uncommon: '#4fc94f',
    Rare: '#3b82f6', Epic: '#a855f7', Legendary: '#f59e0b', Mythic: '#ef4444',
};

// ── Noise Functions (identical to server) ────────────────────
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
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const n00 = hashNoise(ix, iy, seed), n10 = hashNoise(ix + 1, iy, seed);
    const n01 = hashNoise(ix, iy + 1, seed), n11 = hashNoise(ix + 1, iy + 1, seed);
    return (n00 + sx * (n10 - n00)) + sy * ((n01 + sx * (n11 - n01)) - (n00 + sx * (n10 - n00)));
}
function fbm(x, y, seed, octaves) {
    let v = 0, a = 1, f = 1, t = 0;
    for (let i = 0; i < octaves; i++) { v += smoothNoise(x * f, y * f, seed + i * 1000) * a; t += a; a *= 0.5; f *= 2; }
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
// Road corridor segments (recomputed when VILLAGES changes from server init)
let ROAD_SEGMENTS = [];
function recomputeRoadSegments() {
    ROAD_SEGMENTS = VILLAGES.map(v => ({ x1: OUTPOST_X, y1: OUTPOST_Y, x2: v.cx, y2: v.cy }));
}
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
    const dx = tx - OUTPOST_X, dy = ty - OUTPOST_Y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= OUTPOST_RADIUS) return 'outpost';
    // Village overrides
    for (const v of VILLAGES) {
        const vdx = tx - v.cx, vdy = ty - v.cy;
        if (Math.sqrt(vdx * vdx + vdy * vdy) <= v.radius) return 'outpost';
    }
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
    if (ROAD_SEGMENTS.length > 0) {
        const roadDist = distToRoadCorridor(tx, ty);
        if (roadDist < 5) {
            const t = 1 - roadDist / 5;
            const minElev = 0.36 + t * 0.14;
            elev = Math.max(elev, minElev);
        }
    }
    return getBiome(elev, moist);
}
// ── Ore Node Types (visual colors for different rock types) ──
const ORE_NODE_TYPES = {
    stone:    { color: '#6b7280', highlight: '#9ca3af', name: 'Stone' },
    tin:      { color: '#8fa4a0', highlight: '#b5c7c3', name: 'Tin' },
    copper:   { color: '#b87333', highlight: '#d4956a', name: 'Copper' },
    coal:     { color: '#374151', highlight: '#555e6b', name: 'Coal' },
    iron:     { color: '#a8a8a8', highlight: '#d4d4d4', name: 'Iron' },
    gold:     { color: '#ffd700', highlight: '#ffe44d', name: 'Gold' },
    mithril:  { color: '#7dd3fc', highlight: '#bae6fd', name: 'Mithril' },
    titanium: { color: '#e2e8f0', highlight: '#f1f5f9', name: 'Titanium' },
    platinum: { color: '#d4d4d8', highlight: '#e4e4e7', name: 'Platinum' },
    dragonite:{ color: '#dc2626', highlight: '#f87171', name: 'Dragonite' },
};
function getOreNodeType(tx, ty, seed, biome) {
    const h2 = hashNoise(tx, ty, seed + 77777);
    if (biome === 'grass') return h2 < 0.30 ? 'stone' : h2 < 0.50 ? 'tin' : h2 < 0.72 ? 'copper' : h2 < 0.88 ? 'coal' : 'iron';
    if (biome === 'hills') return h2 < 0.15 ? 'stone' : h2 < 0.25 ? 'tin' : h2 < 0.40 ? 'copper' : h2 < 0.50 ? 'coal' : h2 < 0.65 ? 'iron' : h2 < 0.80 ? 'gold' : h2 < 0.92 ? 'mithril' : 'titanium';
    if (biome === 'mountain') return h2 < 0.10 ? 'coal' : h2 < 0.25 ? 'iron' : h2 < 0.40 ? 'gold' : h2 < 0.55 ? 'mithril' : h2 < 0.72 ? 'titanium' : h2 < 0.90 ? 'platinum' : 'dragonite';
    if (biome === 'snow') return h2 < 0.15 ? 'coal' : h2 < 0.30 ? 'iron' : h2 < 0.50 ? 'gold' : h2 < 0.70 ? 'mithril' : h2 < 0.88 ? 'titanium' : 'platinum';
    if (biome === 'desert') return h2 < 0.20 ? 'stone' : h2 < 0.40 ? 'copper' : h2 < 0.55 ? 'tin' : h2 < 0.75 ? 'gold' : 'iron';
    return h2 < 0.40 ? 'stone' : h2 < 0.60 ? 'tin' : h2 < 0.80 ? 'copper' : 'iron';
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
    // Sand: scattered trees along the shore (fish via rod + water only)
    if (biome === 'sand') {
        if (h > 0.92) return { type: 'tree' };
    }
    // Snow: rocks
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
        const vdx = tx - v.cx, vdy = ty - v.cy;
        if (Math.sqrt(vdx * vdx + vdy * vdy) <= v.radius) return true;
    }
    return false;
}
function getDifficultyTier(tx, ty) {
    const dx = tx - OUTPOST_X, dy = ty - OUTPOST_Y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let minVillageDist = Infinity;
    for (const v of VILLAGES) {
        const vdx = tx - v.cx, vdy = ty - v.cy;
        minVillageDist = Math.min(minVillageDist, Math.sqrt(vdx * vdx + vdy * vdy));
    }
    const effectiveDist = Math.min(dist, minVillageDist + 40);
    if (effectiveDist < 30) return 0; if (effectiveDist < 70) return 1; if (effectiveDist < 140) return 2; return 3;
}
function getWaterZone(tx, ty, seed) {
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

// ── Fish Species Catalog (client-side mirror for album UI) ───
const FISH_SPECIES = {
    fish_minnow:       { family: 'Minnow',    emoji: '🐟', name: 'Minnow',           minW: 0.5, maxW: 2,  rodTier: 0, zones: ['shallow','river'],          rarity: 'Common' },
    fish_sunfish:      { family: 'Minnow',    emoji: '🌻', name: 'Sunfish',           minW: 1,   maxW: 3,  rodTier: 0, zones: ['shallow','river'],          rarity: 'Common' },
    fish_bass:         { family: 'Bass',       emoji: '🐟', name: 'Bass',              minW: 1,   maxW: 4,  rodTier: 0, zones: ['shallow','river','deep'],   rarity: 'Common' },
    fish_perch:        { family: 'Bass',       emoji: '🐟', name: 'Perch',             minW: 1,   maxW: 3,  rodTier: 0, zones: ['shallow','river'],          rarity: 'Common' },
    fish_trout:        { family: 'Trout',      emoji: '🐠', name: 'Trout',             minW: 1,   maxW: 4,  rodTier: 0, zones: ['shallow','river','arctic'], rarity: 'Common' },
    fish_clownfish:    { family: 'Trout',      emoji: '🤡', name: 'Clownfish',         minW: 0.5, maxW: 2,  rodTier: 0, zones: ['shallow'],                  rarity: 'Common' },
    fish_catfish:      { family: 'Catfish',    emoji: '🐡', name: 'Catfish',           minW: 3,   maxW: 7,  rodTier: 1, zones: ['river','deep'],             rarity: 'Uncommon' },
    fish_carp:         { family: 'Catfish',    emoji: '🐟', name: 'Carp',              minW: 3,   maxW: 6,  rodTier: 1, zones: ['river'],                    rarity: 'Common' },
    fish_pike:         { family: 'Catfish',    emoji: '🐟', name: 'Pike',              minW: 4,   maxW: 8,  rodTier: 1, zones: ['river','deep'],             rarity: 'Uncommon' },
    fish_salmon:       { family: 'Salmon',     emoji: '🐠', name: 'Salmon',            minW: 3,   maxW: 7,  rodTier: 1, zones: ['river','deep','arctic'],    rarity: 'Uncommon' },
    fish_rainbow_trout:{ family: 'Salmon',     emoji: '🌈', name: 'Rainbow Trout',     minW: 4,   maxW: 8,  rodTier: 1, zones: ['river','arctic'],           rarity: 'Uncommon' },
    fish_king_salmon:  { family: 'Salmon',     emoji: '👑', name: 'King Salmon',       minW: 5,   maxW: 8,  rodTier: 1, zones: ['arctic'],                   rarity: 'Rare' },
    fish_pufferfish:   { family: 'Puffer',     emoji: '🐡', name: 'Pufferfish',        minW: 2,   maxW: 5,  rodTier: 1, zones: ['shallow','deep'],           rarity: 'Uncommon' },
    fish_jellyfish:    { family: 'Puffer',     emoji: '🪼', name: 'Jellyfish',         minW: 2,   maxW: 6,  rodTier: 1, zones: ['deep'],                     rarity: 'Uncommon' },
    fish_electric_eel: { family: 'Eel',        emoji: '⚡', name: 'Electric Eel',      minW: 5,   maxW: 10, rodTier: 2, zones: ['river','deep'],             rarity: 'Rare' },
    fish_stingray:     { family: 'Eel',        emoji: '🦟', name: 'Stingray',          minW: 5,   maxW: 9,  rodTier: 2, zones: ['shallow','deep'],           rarity: 'Uncommon' },
    fish_swordfish:    { family: 'Swordfish',  emoji: '🗡️', name: 'Swordfish',        minW: 6,   maxW: 11, rodTier: 2, zones: ['deep'],                     rarity: 'Rare' },
    fish_marlin:       { family: 'Swordfish',  emoji: '🏹', name: 'Marlin',            minW: 7,   maxW: 12, rodTier: 2, zones: ['deep'],                     rarity: 'Rare' },
    fish_barracuda:    { family: 'Swordfish',  emoji: '🦷', name: 'Barracuda',         minW: 6,   maxW: 10, rodTier: 2, zones: ['deep','arctic'],            rarity: 'Rare' },
    fish_anglerfish:   { family: 'DeepSea',    emoji: '🏮', name: 'Anglerfish',        minW: 5,   maxW: 10, rodTier: 2, zones: ['deep'],                     rarity: 'Rare' },
    fish_octopus:      { family: 'DeepSea',    emoji: '🐙', name: 'Octopus',           minW: 6,   maxW: 12, rodTier: 2, zones: ['deep'],                     rarity: 'Rare' },
    fish_shark:        { family: 'Shark',      emoji: '🦈', name: 'Shark',             minW: 10,  maxW: 15, rodTier: 3, zones: ['deep'],                     rarity: 'Epic' },
    fish_hammerhead:   { family: 'Shark',      emoji: '🔨', name: 'Hammerhead',        minW: 12,  maxW: 16, rodTier: 3, zones: ['deep'],                     rarity: 'Epic' },
    fish_ghost_fish:   { family: 'Shark',      emoji: '👻', name: 'Ghost Fish',        minW: 10,  maxW: 14, rodTier: 3, zones: ['arctic'],                   rarity: 'Epic' },
    fish_whale:        { family: 'Whale',      emoji: '🐳', name: 'Whale',             minW: 12,  maxW: 16, rodTier: 3, zones: ['deep','arctic'],            rarity: 'Epic' },
    fish_narwhal:      { family: 'Whale',      emoji: '🦄', name: 'Narwhal',           minW: 13,  maxW: 16, rodTier: 3, zones: ['arctic'],                   rarity: 'Epic' },
    fish_kraken:       { family: 'Legendary',  emoji: '🦑', name: 'Kraken Tentacle',   minW: 15,  maxW: 19, rodTier: 4, zones: ['deep'],                     rarity: 'Legendary' },
    fish_golden:       { family: 'Legendary',  emoji: '🏆', name: 'Golden Fish',       minW: 16,  maxW: 20, rodTier: 4, zones: ['arctic'],                   rarity: 'Legendary' },
    fish_leviathan:    { family: 'Legendary',  emoji: '🐲', name: 'Leviathan Scale',   minW: 18,  maxW: 20, rodTier: 4, zones: ['deep'],                     rarity: 'Legendary' },
};

// ── Game State ───────────────────────────────────────────────
let gameCanvas, gameCtx, ws;
let worldSeed = 0;
let myPlayer = null;
let myUserId = null;
let players = {};
let mobs = {};        // live world mobs from server
let structures = [];
let depletedNodes = new Map(); // "x,y" → respawnAt timestamp
let groundItems = {};          // groundItemId → { id, itemId, qty, x, y, name, emoji, rarity }
let deathDropAnims = [];       // animated items flying out from death point
let gameConnected = false;
let gameRunning = false;
let gameLoopId = null;
let gamePingTimer = null;
let lastStateSeq = 0;
let lastStateAt = 0;
let pendingPingSentAt = 0;
let networkStats = { rtt: 0, jitter: 0, stateRate: 0, packetSkips: 0, nearbyPlayers: 0 };
let gameIdentity = { isAnon: false, anonId: null };

// Camera (smooth lerp)
let camX = 0, camY = 0;
let camTargetX = 0, camTargetY = 0;
const CAM_W = 960, CAM_H = 640;
const CAM_LERP = 0.12; // camera smoothing factor

// Input
const keys = {};
let mouseX = 0, mouseY = 0;
let mouseWorldX = 0, mouseWorldY = 0;
let frameDeltaMs = 16;
let lastFrameAt = performance.now();

// Movement physics
let playerVelX = 0;
let playerVelY = 0;
let lastMoveSendAt = 0;
let lastMoveSentX = 0;
let lastMoveSentY = 0;
const movementBodyStates = new Map();

// Sprint
let isSprinting = false;
const SPRINT_MULT = 1.7;

// Agility bonuses (synced from server)
let agilityBonuses = { maxStaminaBonus: 0, regenBonus: 0, sprintDrainMult: 1.0, dodgeCostReduct: 0, swimSpeedMult: 1.0, sprintSpeedMult: 1.0 };

// Day/Night cycle (20 min real time = 1 in-game day)
let dayTime = 0; // 0–1 (0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset)
const DAY_CYCLE_MS = 20 * 60 * 1000; // 20 min full cycle
let dayStartMs = Date.now();

// Screen shake
let shakeIntensity = 0;
let shakeDecay = 0.9;
let shakeOffsetX = 0, shakeOffsetY = 0;

// Attack cooldown
let lastAttackTime = 0;
const BASE_ATTACK_COOLDOWN = 800; // ms
let attackCooldown = BASE_ATTACK_COOLDOWN;
let swingAnim = 0; // 0–1 swing arc animation
let swingType = 'attack'; // 'attack', 'mine', 'chop', 'punch' — affects swing visual

// Dodge roll
let dodgeCooldownUntil = 0;
let dodgeAnimTimer = 0;
let dodgeAnimDx = 0, dodgeAnimDy = 0;
let dodgeFlashTimer = 0;

// Jump system (visual z-axis — purely client-side cosmetic)
let jumpHeight = 0;          // Current height above ground (pixels)
let jumpVelocity = 0;        // Vertical velocity (pixels/frame)
const JUMP_STRENGTH = 6.8;   // Initial upward velocity
const JUMP_GRAVITY = 0.38;   // Gravity pull per frame
let isJumping = false;
let jumpCooldownUntil = 0;
const JUMP_COOLDOWN_MS = 350;
let jumpSquashTimer = 0;     // Landing squash-stretch timer
let jumpParticles = [];       // Dust particles on land

// Gather/mining particle effects
let gatherParticles = [];

// Combo tracking (client mirror of server combos)
let comboCount = 0;
let comboTimer = 0;
const COMBO_DISPLAY_MS = 2500;

// Food buff (from server)
let activeFoodBuff = null; // { name, expiresAt, effects }

// Weapon/food info from server init
let serverWeaponStats = {};
let serverFoodEffects = {};

// ── Hotbar (Minecraft-style) ──
// 9 slots for quick-access items (tools, weapons, food)
let hotbarSlots = new Array(9).fill(null); // each: { item_id, name, emoji, category } or null
let activeHotbarSlot = 0; // 0-8 (Digit1 = 0, Digit9 = 8)
const HOTBAR_EQUIP_CATS = new Set(['weapons', 'armor', 'hats', 'pickaxes', 'axes', 'rods']);
const HOTBAR_USE_CATS = new Set(['food', 'consumable', 'potion']);
const HOTBAR_VALID_CATS = new Set([...HOTBAR_EQUIP_CATS, ...HOTBAR_USE_CATS]);

// Player facing direction
let facingAngle = 0; // radians

// Build mode
let buildMode = false;
let selectedStructure = null;
let ghostTileX = 0, ghostTileY = 0;

// Panels
let activePanel = null; // 'inventory','bank','shop','crafting','skills','map','leaderboard','build','quests'
let panelData = {};
let panelAnimProgress = 0;   // 0→1 slide-in animation progress
let panelAnimDir = 0;        // 1 = opening, -1 = closing, 0 = idle
let panelClosingTo = null;   // panel name queued after close animation
let panelAnimSpeed = 0.08;   // ~12 frames ≈ 200ms at 60fps

// Chat
let chatMessages = [];
let chatInput = '';
let chatOpen = false;

// Death screen
let isDead = false;
let deathDropped = [];

// Biome tile cache (offscreen canvas)
let biomeCache = null;
let biomeCacheReady = false;
let biomeCacheSeed = 0;

// Gather cooldown
let lastGatherTime = 0;
let lastFishTime = 0;

// ── Fog of War ───────────────────────────────────────────────
const FOG_REVEAL_RADIUS = 15; // tiles around player that get revealed
let exploredTiles = new Set(); // "tx,ty" strings
let fogCanvas = null;          // offscreen canvas for minimap fog overlay
let fogDirty = true;           // redraw fog canvas when tiles newly explored

function loadExploredTiles() {
    try {
        const raw = localStorage.getItem('openvibegame_explored');
        if (raw) {
            const arr = JSON.parse(raw);
            exploredTiles = new Set(arr);
        }
    } catch (_) {}
}
function saveExploredTiles() {
    try {
        // Only save up to 60k tiles to avoid localStorage overflow
        const arr = [...exploredTiles];
        if (arr.length > 60000) arr.length = 60000;
        localStorage.setItem('openvibegame_explored', JSON.stringify(arr));
    } catch (_) {}
}
function revealFog(centerTx, centerTy) {
    let revealed = false;
    const r = FOG_REVEAL_RADIUS;
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const k = `${centerTx + dx},${centerTy + dy}`;
            if (!exploredTiles.has(k)) {
                exploredTiles.add(k);
                revealed = true;
            }
        }
    }
    if (revealed) fogDirty = true;
}

// Fish sonar overlay
let sonarOverlay = null; // { zones: [...], expiresAt }

// ── Weather State ────────────────────────────────────────────
let currentWeather = { type: 'clear', emoji: '☀️' };
let weatherParticles = []; // { x, y, dx, dy, life }
const MAX_WEATHER_PARTICLES = 200;

// ── Treasure Chests ──────────────────────────────────────────
let chests = {}; // chestId → { id, tier, x, y, emoji }

// ── Achievement System ───────────────────────────────────────
let myAchievements = [];     // [{ id, name, desc, reward, category, emoji, earned }]
let achievementToasts = [];  // [{ text, emoji, timer }]

// ── Daily Quests ─────────────────────────────────────────────
let myDailyQuests = [];      // [{ id, name, desc, progress, target, completed, claimed, reward }]
let dailyQuestMeta = { claimed: 0, total: 0, completed: 0, streak: 0, nextResetAt: null, date: '' };
let dailyQuestLastSync = 0;
const dailyQuestReadyNotified = new Set();

// ── Fishing Mini-Game State (Toontown-style) ─────────────────
const FISHING = {
    active: false,
    phase: 'idle',          // idle → targeting → casting → reeling → result
    tileX: 0, tileY: 0,    // water tile being fished
    zone: '',
    // Targeting phase — fish shadows swimming in pond view
    shadows: [],            // [{ x, y, baseX, baseY, angle, speed, radius, size }]
    shadowCount: 0,
    pondRect: { x: 0, y: 0, w: 0, h: 0 }, // the pond overlay area
    cursorX: 0, cursorY: 0, // aim cursor position (mouse-relative inside pond)
    // Casting phase
    castX: 0, castY: 0,    // where the cast lands
    castAnim: 0,            // 0→1 animation progress
    castHit: false,         // did it land on a shadow?
    // Reeling phase — timing bar
    reelRound: 0,           // current round (0-2, 3 rounds total)
    reelScore: 0,           // successful hits so far
    reelBarPos: 0,          // oscillating indicator position (0→1→0)
    reelBarDir: 1,          // direction of oscillation
    reelBarSpeed: 0.015,    // speed (increases per round)
    reelSweetSpot: 0.4,     // center of sweet spot (0-1)
    reelSweetWidth: 0.25,   // width of sweet spot
    reelClicked: false,     // did player click this round?
    reelResultTimer: 0,     // brief pause to show round result
    reelRoundResult: '',    // 'hit' or 'miss' for current round
    // Result phase
    resultTimer: 0,
    resultData: null,       // server response
};

// Inventory grid state (Minecraft-style)
let invGridHeldItem = null; // item being dragged: { item_id, name, emoji, rarity, quantity, category, fromSlot }
let invGridScroll = 0;      // scroll offset for grid

// Theme (read from CSS variables for canvas UI consistency)
let theme = {};
function loadTheme() {
    const s = getComputedStyle(document.documentElement);
    const v = (name, fb) => s.getPropertyValue(name).trim() || fb;
    theme = {
        bg: v('--bg-primary', '#0d0d0f'),
        bgPanel: v('--bg-secondary', '#16161a'),
        bgCard: v('--bg-card', '#1a1a20'),
        bgHover: v('--bg-hover', '#242430'),
        accent: v('--accent', '#8b5cf6'),
        accentLight: v('--accent-light', '#a78bfa'),
        accentDark: v('--accent-dark', '#6d28d9'),
        text: v('--text-primary', '#e8e6e3'),
        textDim: v('--text-secondary', '#9a9a9a'),
        textMuted: v('--text-muted', '#666'),
        border: v('--border', '#2a2a32'),
        success: v('--success', '#2ecc71'),
        danger: v('--danger', '#e74c3c'),
    };
}

// Crafting panel state
let craftCategory = 'all';
let craftScroll = 0;
let craftInventory = {}; // item_id → qty
let fishAlbumScroll = 0; // scroll offset for fish album panel
const CRAFT_CATS = [
    { id: 'all', label: '📋 All' },
    { id: 'smelt', label: '🔥 Smelt' },
    { id: 'combat', label: '⚔️ Arms' },
    { id: 'potion', label: '🧪 Pots' },
    { id: 'material', label: '🪵 Mats' },
    { id: 'hat', label: '🎩 Hats' },
    { id: 'cook', label: '🍳 Cook' },
];

function getRecipeCategory(output) {
    if (output.startsWith('food_')) return 'cook';
    if (output.startsWith('bar_')) return 'smelt';
    if (output.startsWith('weapon_') || output.startsWith('armor_') || output === 'craft_shield' || output === 'craft_arrow') return 'combat';
    if (output.startsWith('hat_')) return 'hat';
    if (output.includes('potion') || output.includes('elixir') || output.includes('xp_potion') || output === 'craft_loot_magnet') return 'potion';
    if (output === 'craft_plank' || output === 'craft_charcoal' || output === 'compost') return 'material';
    return 'material';
}

// NPC data (loaded from server on init)
let NPCS = [];
let townDeco = [];
let townPathSet = new Set();
const NPC_INTERACT_RANGE = 3; // tiles
let activeNPC = null; // currently interacted NPC id
let npcShopData = null; // { items, inventory, openvibe_coins } or { bank, inventory, openvibe_coins }
let npcShopTab = 'buy'; // 'buy' or 'sell'
let npcShopScroll = 0;

function isNearNPC(npc) {
    if (!myPlayer) return false;
    const px = Math.floor(myPlayer.x / TILE), py = Math.floor(myPlayer.y / TILE);
    return Math.abs(px - npc.tileX) <= NPC_INTERACT_RANGE && Math.abs(py - npc.tileY) <= NPC_INTERACT_RANGE;
}

function getNearestNPC() {
    if (!myPlayer) return null;
    const px = Math.floor(myPlayer.x / TILE), py = Math.floor(myPlayer.y / TILE);
    let best = null, bestDist = Infinity;
    for (const npc of NPCS) {
        const d = Math.abs(px - npc.tileX) + Math.abs(py - npc.tileY);
        if (d <= NPC_INTERACT_RANGE * 2 && d < bestDist) { best = npc; bestDist = d; }
    }
    return best;
}

// Minimap
let minimapCanvas = null, minimapCtx = null;
let minimapReady = false;

// Loading state
const LOADING_TIPS = [
    '💡 Tip: Bank your loot at the Town NPC to keep it safe from PvP death!',
    '💡 Tip: Higher-tier zones have better loot but tougher monsters.',
    '💡 Tip: Press B to enter build mode and place structures.',
    '💡 Tip: Sleeping bags let you respawn at your base instead of Town.',
    '💡 Tip: Tools can break! Keep spares in your inventory.',
    '💡 Tip: Craft potions to heal mid-combat. Stay alive out there!',
    '💡 Tip: Storage boxes protect extra items from PvP raids.',
    '💡 Tip: The further from Town, the better the loot drops.',
];
let loadingProgress = 0;

function updateLoadingUI(title, status, progress) {
    const overlay = document.getElementById('game-loading-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    if (title) document.getElementById('game-loading-title').textContent = title;
    if (status) document.getElementById('game-loading-status').textContent = status;
    if (typeof progress === 'number') {
        loadingProgress = progress;
        document.getElementById('game-loading-bar').style.width = progress + '%';
    }
}

function hideLoadingUI() {
    const overlay = document.getElementById('game-loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

function showRandomTip() {
    const el = document.getElementById('game-loading-tips');
    if (el) el.innerHTML = `<p>${LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)]}</p>`;
}

function updateConnectionBadge(state) {
    const badge = document.getElementById('game-conn-badge');
    const text = document.getElementById('game-conn-text');
    if (!badge) return;
    badge.className = 'game-connection-badge ' + state;
    if (state === 'connecting') text.textContent = 'Connecting...';
    else if (state === 'connected') text.textContent = 'Online';
    else text.textContent = 'Offline';
}

function startGamePingLoop() {
    if (gamePingTimer) clearInterval(gamePingTimer);
    gamePingTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        pendingPingSentAt = Date.now();
        sendWs({ type: 'ping', t: pendingPingSentAt });
    }, 3000);
}

function stopGamePingLoop() {
    if (gamePingTimer) {
        clearInterval(gamePingTimer);
        gamePingTimer = null;
    }
}

function handleGamePong(msg) {
    const echoedAt = Number(msg.echo || pendingPingSentAt || 0);
    if (!echoedAt) return;
    const rtt = Math.max(0, Date.now() - echoedAt);
    networkStats.jitter = networkStats.rtt ? Math.round(networkStats.jitter * 0.7 + Math.abs(networkStats.rtt - rtt) * 0.3) : 0;
    networkStats.rtt = Math.round(networkStats.rtt * 0.5 + rtt * 0.5);
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

function loadGamePage() {
    gameCanvas = document.getElementById('game-canvas');
    if (!gameCanvas) return;
    gameCtx = gameCanvas.getContext('2d');
    gameCanvas.width = CAM_W;
    gameCanvas.height = CAM_H;
    loadTheme();

    document.getElementById('game-login-overlay').style.display = 'none';
    if (!gameConnected) {
        showRandomTip();
        updateLoadingUI('Connecting to OpenVibeGame...', 'Establishing connection', 10);
        updateConnectionBadge('connecting');
        connectGame();
    }
}

function connectGame() {
    const token = localStorage.getItem('token');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = token ? `?token=${encodeURIComponent(token)}` : '';

    updateLoadingUI('Connecting to OpenVibeGame...', 'Opening WebSocket...', 20);
    updateConnectionBadge('connecting');

    ws = new WebSocket(`${proto}://${location.host}/ws/game${query}`);
    ws.onopen = () => {
        gameConnected = true;
        lastStateSeq = 0;
        lastStateAt = 0;
        networkStats = { rtt: 0, jitter: 0, stateRate: 0, packetSkips: 0, nearbyPlayers: 0 };
        updateConnectionBadge('connected');
        updateLoadingUI('Connected!', 'Loading world data...', 50);
        addChatMsg('⚡ Connected to OpenVibeGame');
        startGamePingLoop();
    };
    ws.onclose = () => {
        gameConnected = false;
        stopGamePingLoop();
        updateConnectionBadge('disconnected');
        addChatMsg('❌ Disconnected');
        setTimeout(() => { if (currentPage === 'game') connectGame(); }, 3000);
    };
    ws.onerror = () => {
        stopGamePingLoop();
        updateConnectionBadge('disconnected');
        updateLoadingUI('Connection Error', 'Retrying in 3 seconds...', 0);
    };
    ws.onmessage = (e) => handleServerMsg(JSON.parse(e.data));
    // Save fog of war on page unload
    if (!window._openvibeGameBeforeUnloadBound) {
        window._openvibeGameBeforeUnloadBound = true;
        window.addEventListener('beforeunload', () => saveExploredTiles());
    }
}

function handleServerMsg(msg) {
    switch (msg.type) {
        case 'init': handleInit(msg); break;
        case 'state': handleState(msg); break;
        case 'player_join': addChatMsg(`👋 ${msg.username} joined`); break;
        case 'player_leave':
            delete players[msg.userId];
            addChatMsg(`👋 Player left`);
            break;
        case 'gather_result': handleGatherResult(msg); break;
        case 'gather_effect': handleGatherEffect(msg); break;
        case 'fish_result': handleFishResult(msg); break;
        case 'fish_effect': handleFishEffect(msg); break;
        case 'node_depleted':
            depletedNodes.set(`${msg.tileX},${msg.tileY}`, msg.respawnAt);
            break;
        case 'build_result': handleBuildResult(msg); break;
        case 'structure_placed':
            structures.push(msg.structure);
            break;
        case 'destroy_result':
            if (msg.success) addChatMsg('🔨 Structure demolished');
            else if (msg.error) addChatMsg(`❌ ${msg.error}`);
            break;
        case 'structure_destroyed':
            structures = structures.filter(s => !(s.tile_x === msg.tileX && s.tile_y === msg.tileY));
            break;
        case 'attack_result': handleAttackResult(msg); break;
        case 'mob_attack_result': handleMobAttackResult(msg); break;
        case 'mob_hit_player': handleMobHitPlayer(msg); break;
        case 'mob_killed': handleMobKilled(msg); break;
        case 'combat_hit': handleCombatHit(msg); break;
        case 'player_died': handlePlayerDied(msg); break;
        case 'respawn': handleRespawn(msg); break;
        case 'dodge_result': handleDodgeResult(msg); break;
        case 'eat_food_result': handleEatFoodResult(msg); break;
        case 'pickup_result': handlePickupResult(msg); break;
        case 'ground_item_pickup':
            delete groundItems[msg.groundId];
            break;
        case 'chest_result': handleChestResult(msg); break;
        case 'chest_opened':
            delete chests[msg.chestId];
            break;
        case 'achievements_earned': handleAchievementsEarned(msg); break;
        case 'sprint_exhausted':
            isSprinting = false;
            addChatMsg('😮‍💨 Out of stamina!');
            break;
        case 'stamina_update':
            if (myPlayer) {
                myPlayer.stamina = msg.stamina;
                myPlayer.max_stamina = msg.maxStamina;
            }
            break;
        case 'game_chat':
            addChatMsg(`${msg.username}: ${msg.text}`);
            break;
        case 'pong': handleGamePong(msg); break;
    }
}

function handleInit(msg) {
    updateLoadingUI('Loading World...', 'Generating terrain...', 60);

    myPlayer = msg.player;
    gameIdentity = msg.identity || { isAnon: false, anonId: null };
    myUserId = myPlayer.user_id;
    playerVelX = 0;
    playerVelY = 0;
    lastMoveSentX = myPlayer.x || 0;
    lastMoveSentY = myPlayer.y || 0;
    lastMoveSendAt = Date.now();
    movementBodyStates.clear();
    worldSeed = msg.worldSeed;
    // Sync map dimensions from server
    MAP_W = msg.mapW || MAP_W;
    MAP_H = msg.mapH || MAP_H;
    OUTPOST_X = Math.floor(MAP_W / 2);
    OUTPOST_Y = Math.floor(MAP_H / 2);
    VILLAGES = msg.villages || [];
    recomputeRoadSegments();
    agilityBonuses = msg.agilityBonuses || agilityBonuses;
    structures = msg.structures || [];
    players = msg.players || {};
    mobs = msg.mobs || {};
    groundItems = msg.groundItems || {};
    NPCS = msg.npcs || [];
    townDeco = msg.townDeco || [];
    townPathSet = new Set(msg.townPaths || []);
    dayStartMs = Date.now();
    serverWeaponStats = msg.weaponStats || {};
    serverFoodEffects = msg.foodEffects || {};
    updateWeaponCooldown();
    // Weather, chests, achievements, quests from init
    if (msg.weather) currentWeather = msg.weather;
    chests = msg.chests || {};
    const achData = msg.achievements || {};
    myAchievements = achData.achievements || [];
    applyDailyQuestData(msg.dailyQuests);

    // Load depleted nodes
    depletedNodes.clear();
    (msg.depletedNodes || []).forEach(n => depletedNodes.set(`${n.x},${n.y}`, n.respawnAt));

    updateCoinDisplay();

    updateLoadingUI('Loading World...', 'Building biome cache...', 75);
    generateBiomeCache();
    loadExploredTiles();

    updateLoadingUI('Loading World...', 'Rendering minimap...', 90);
    generateMinimap();

    updateLoadingUI('Ready!', 'Entering world...', 100);
    setTimeout(() => hideLoadingUI(), 400);

    if (!gameRunning) { gameRunning = true; gameLoop(); }
    const welcomeName = gameIdentity.isAnon ? (gameIdentity.anonId || myPlayer.display_name || 'anon') : (myPlayer.display_name || myPlayer.username || 'traveler');
    addChatMsg(`🌍 Welcome to OpenVibeGame, ${welcomeName}! Click resources to gather, E to pickup/interact. [1-9] hotbar, [I] inventory.`);

    // Pre-load inventory for hotbar population
    loadPanelData('inventory');
    refreshDailyQuests(true);
}

function handleState(msg) {
    if (typeof msg.seq === 'number') {
        if (msg.seq <= lastStateSeq) return;
        if (lastStateSeq && msg.seq > lastStateSeq + 1) networkStats.packetSkips += (msg.seq - lastStateSeq - 1);
        lastStateSeq = msg.seq;
    }

    const now = Date.now();
    if (lastStateAt) {
        const delta = now - lastStateAt;
        const rate = delta > 0 ? 1000 / delta : 0;
        networkStats.stateRate = networkStats.stateRate ? (networkStats.stateRate * 0.75 + rate * 0.25) : rate;
    }
    lastStateAt = now;

    // Track previous positions for walking animation detection
    const newPlayers = msg.players || {};
    for (const [uid, p] of Object.entries(newPlayers)) {
        const old = players[uid];
        if (old) { p._prevX = old.x; p._prevY = old.y; }
        else { p._prevX = p.x; p._prevY = p.y; }
    }
    players = newPlayers;
    networkStats.nearbyPlayers = Math.max(0, Object.keys(players).length - (myUserId ? 1 : 0));

    if (myUserId != null && players[myUserId] && myPlayer) {
        const serverSelf = players[myUserId];
        const dx = serverSelf.x - myPlayer.x;
        const dy = serverSelf.y - myPlayer.y;
        const drift = Math.hypot(dx, dy);
        if (drift > TILE * 2.5) {
            myPlayer.x += dx * 0.45;
            myPlayer.y += dy * 0.45;
        }
        if (serverSelf.hp != null) myPlayer.hp = serverSelf.hp;
        if (serverSelf.max_hp != null) myPlayer.max_hp = serverSelf.max_hp;
    }
    mobs = msg.mobs || {};
    groundItems = msg.groundItems || {};
    chests = msg.chests || {};
    if (msg.weather) currentWeather = msg.weather;
}

// ══════════════════════════════════════════════════════════════
//  BIOME CACHE (offscreen pre-render of terrain)
// ══════════════════════════════════════════════════════════════

function generateBiomeCache() {
    // We don't pre-render the whole map at once (too big).
    // Instead, we render tiles on-the-fly per frame within the viewport.
    biomeCacheSeed = worldSeed;
    biomeCacheReady = true;
}

function generateMinimap() {
    minimapCanvas = document.createElement('canvas');
    minimapCanvas.width = MAP_W;
    minimapCanvas.height = MAP_H;
    minimapCtx = minimapCanvas.getContext('2d');
    // Build NPC building tile set for minimap
    const mmBuildSet = new Set();
    for (const npc of NPCS) {
        for (const [bx, by] of (npc.buildTiles || [])) mmBuildSet.add(`${bx},${by}`);
    }
    // Render in chunks to avoid blocking
    let row = 0;
    function renderChunk() {
        const end = Math.min(row + 32, MAP_H);
        for (let y = row; y < end; y++) {
            for (let x = 0; x < MAP_W; x++) {
                const b = getBiomeAt(x, y, worldSeed);
                const key = `${x},${y}`;
                if (b === 'outpost' && townPathSet.has(key)) {
                    minimapCtx.fillStyle = '#8a8278'; // cobblestone
                } else if (b === 'outpost' && mmBuildSet.has(key)) {
                    minimapCtx.fillStyle = '#5a4a3a'; // buildings
                } else {
                    minimapCtx.fillStyle = BIOME_COLORS[b] || '#333';
                }
                minimapCtx.fillRect(x, y, 1, 1);
            }
        }
        row = end;
        if (row < MAP_H) requestAnimationFrame(renderChunk);
        else minimapReady = true;
    }
    renderChunk();
}

// ══════════════════════════════════════════════════════════════
//  GAME LOOP
// ══════════════════════════════════════════════════════════════

function gameLoop() {
    if (!gameRunning) return;
    gameLoopId = requestAnimationFrame(gameLoop);
    if (Date.now() - dailyQuestLastSync > 15000) refreshDailyQuests();
    const now = performance.now();
    frameDeltaMs = Math.min(40, Math.max(8, now - lastFrameAt || 16));
    lastFrameAt = now;
    update();
    render();
}

function getMoveBodyState(id) {
    let state = movementBodyStates.get(id);
    if (!state) {
        state = {
            renderX: 0,
            renderY: 0,
            velX: 0,
            velY: 0,
            bob: 0,
            bobVel: 0,
            stridePhase: 0,
            strideStrength: 0,
            torsoLeanX: 0,
            torsoLeanY: 0,
            torsoRoll: 0,
            headBob: 0,
            breath: Math.random() * Math.PI * 2,
            plantedFoot: 0,
            lastX: 0,
            lastY: 0,
            initialized: false,
        };
        movementBodyStates.set(id, state);
    }
    return state;
}

function updateMoveBodyState(id, targetX, targetY, dt, options = {}) {
    const state = getMoveBodyState(id);
    const isRemote = !!options.isRemote;
    if (!state.initialized) {
        state.renderX = targetX;
        state.renderY = targetY;
        state.lastX = targetX;
        state.lastY = targetY;
        state.initialized = true;
    }

    const lerp = isRemote ? 0.24 : 0.55;
    state.renderX += (targetX - state.renderX) * lerp;
    state.renderY += (targetY - state.renderY) * lerp;

    const vx = (state.renderX - state.lastX) / Math.max(1, dt);
    const vy = (state.renderY - state.lastY) / Math.max(1, dt);
    state.velX = state.velX * 0.72 + vx * 0.28;
    state.velY = state.velY * 0.72 + vy * 0.28;

    const speed = Math.hypot(state.velX, state.velY);
    const moveAmount = Math.min(1, speed * 14);
    state.strideStrength += (moveAmount - state.strideStrength) * 0.22;
    state.stridePhase += (0.08 + state.strideStrength * 0.22) * (dt / 16);

    const bobTarget = Math.sin(state.stridePhase) * (1.8 + state.strideStrength * 2.2);
    state.bobVel += (bobTarget - state.bob) * 0.18;
    state.bobVel *= 0.72;
    state.bob += state.bobVel;
    state.headBob = Math.sin(state.stridePhase * 2) * state.strideStrength * 1.4;

    state.torsoLeanX += ((state.velX * 18) - state.torsoLeanX) * 0.18;
    state.torsoLeanY += ((state.velY * 18) - state.torsoLeanY) * 0.18;
    state.torsoRoll += ((Math.sin(state.stridePhase) * state.strideStrength * 0.12) - state.torsoRoll) * 0.2;
    state.plantedFoot = Math.sin(state.stridePhase) >= 0 ? 1 : -1;
    state.breath += 0.015 * (dt / 16);

    state.lastX = state.renderX;
    state.lastY = state.renderY;
    return state;
}

function update() {
    if (!myPlayer || isDead) return;

    // Day/night cycle
    dayTime = ((Date.now() - dayStartMs) % DAY_CYCLE_MS) / DAY_CYCLE_MS;

    // Screen shake decay
    if (shakeIntensity > 0.1) {
        shakeOffsetX = (Math.random() - 0.5) * shakeIntensity;
        shakeOffsetY = (Math.random() - 0.5) * shakeIntensity;
        shakeIntensity *= shakeDecay;
    } else { shakeIntensity = 0; shakeOffsetX = 0; shakeOffsetY = 0; }

    // Swing animation decay
    if (swingAnim > 0) swingAnim = Math.max(0, swingAnim - 0.08);

    // Dodge animation decay
    if (dodgeAnimTimer > 0) {
        dodgeAnimTimer -= 16;
        if (dodgeAnimTimer <= 0) { dodgeAnimTimer = 0; dodgeAnimDx = 0; dodgeAnimDy = 0; }
    }
    if (dodgeFlashTimer > 0) dodgeFlashTimer -= 16;

    // Jump physics (visual z-axis)
    if (isJumping) {
        jumpVelocity -= JUMP_GRAVITY;
        jumpHeight += jumpVelocity;
        if (jumpHeight <= 0) {
            // Landing
            jumpHeight = 0;
            jumpVelocity = 0;
            isJumping = false;
            jumpSquashTimer = 8; // frames of squash on land
            // Spawn dust particles
            if (myPlayer) {
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI * 2 / 6) * i + Math.random() * 0.5;
                    jumpParticles.push({
                        x: 0, y: 0,
                        vx: Math.cos(angle) * (1.5 + Math.random() * 1.5),
                        vy: Math.sin(angle) * (0.5 + Math.random()) - 0.5,
                        life: 12 + Math.random() * 8,
                        maxLife: 20,
                        size: 2 + Math.random() * 2,
                    });
                }
            }
        }
    }
    if (jumpSquashTimer > 0) jumpSquashTimer--;
    // Update jump dust particles
    for (let i = jumpParticles.length - 1; i >= 0; i--) {
        const p = jumpParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.life--;
        if (p.life <= 0) jumpParticles.splice(i, 1);
    }
    // Update gather/mining particles
    for (let i = gatherParticles.length - 1; i >= 0; i--) {
        const gp = gatherParticles[i];
        gp.x += gp.vx;
        gp.y += gp.vy;
        gp.vy += 0.12; // gravity
        gp.vx *= 0.96;
        gp.life--;
        if (gp.life <= 0) gatherParticles.splice(i, 1);
    }

    // Combo display timer decay
    if (comboTimer > 0) {
        comboTimer -= 16;
        if (comboTimer <= 0) { comboCount = 0; comboTimer = 0; }
    }

    // Food buff expiry
    if (activeFoodBuff && Date.now() > activeFoodBuff.expiresAt) {
        addChatMsg('🍽️ Food buff expired.');
        activeFoodBuff = null;
    }

    // Fishing mini-game update (runs even when fishing is active)
    updateFishing();

    // Movement (disabled while fishing)
    if (FISHING.active) return;

    const dtNorm = frameDeltaMs / 16;
    const baseSpeed = 3.2;
    const accelBase = 0.52;
    isSprinting = !!keys['ShiftLeft'] || !!keys['ShiftRight'];
    let inputX = 0, inputY = 0;
    if (keys['KeyW'] || keys['ArrowUp']) inputY -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) inputY += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) inputX -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) inputX += 1;

    if (chatOpen) { inputX = 0; inputY = 0; }
    if (inputX && inputY) {
        const n = 1 / Math.sqrt(2);
        inputX *= n;
        inputY *= n;
    }

    const currentTileX = Math.floor(myPlayer.x / TILE);
    const currentTileY = Math.floor(myPlayer.y / TILE);
    const currentBiome = getBiomeAt(currentTileX, currentTileY, worldSeed);
    const probeTX = Math.floor((myPlayer.x + playerVelX * 10 + inputX * TILE) / TILE);
    const probeTY = Math.floor((myPlayer.y + playerVelY * 10 + inputY * TILE) / TILE);
    const targetBiome = getBiomeAt(probeTX, probeTY, worldSeed) || currentBiome;
    const inWater = targetBiome === 'water';

    let maxSpeed = baseSpeed;
    let accel = accelBase;
    let drag = 0.76;
    let anim = 'idle';

    if (isSprinting && !inWater) {
        maxSpeed *= SPRINT_MULT * (agilityBonuses.sprintSpeedMult || 1.0);
        accel *= 1.15;
    }
    if (inWater) {
        maxSpeed *= 0.48 * (agilityBonuses.swimSpeedMult || 1.0);
        accel *= 0.68;
        drag = 0.82;
        anim = 'swim';
    } else if (currentBiome === 'sand') {
        maxSpeed *= 0.93;
        drag = 0.8;
    } else if (currentBiome === 'snow') {
        maxSpeed *= 0.9;
        drag = 0.84;
    }

    // Airborne: reduced drag (momentum preservation) + slight speed boost
    if (isJumping) {
        drag *= 0.92; // Less friction in the air
        maxSpeed *= 1.08;
    }

    if (inputX || inputY) {
        playerVelX += inputX * accel * dtNorm;
        playerVelY += inputY * accel * dtNorm;
    } else {
        playerVelX *= Math.pow(drag, dtNorm);
        playerVelY *= Math.pow(drag, dtNorm);
    }

    const velMag = Math.hypot(playerVelX, playerVelY);
    if (velMag > maxSpeed) {
        const s = maxSpeed / velMag;
        playerVelX *= s;
        playerVelY *= s;
    }
    if (!(inputX || inputY) && velMag < 0.035) {
        playerVelX = 0;
        playerVelY = 0;
    }

    if (inputX || inputY) facingAngle = Math.atan2(inputY, inputX);
    else if (velMag > 0.05) facingAngle = Math.atan2(playerVelY, playerVelX);

    const oldX = myPlayer.x;
    const oldY = myPlayer.y;
    const newX = Math.max(0, Math.min(MAP_W * TILE, myPlayer.x + playerVelX * dtNorm));
    const newY = Math.max(0, Math.min(MAP_H * TILE, myPlayer.y + playerVelY * dtNorm));
    myPlayer.x = newX;
    myPlayer.y = newY;

    const moved = Math.hypot(newX - oldX, newY - oldY);
    if (anim !== 'swim') {
        if (velMag > maxSpeed * 0.72 && isSprinting) anim = 'run';
        else if (velMag > 0.08) anim = 'walk';
    }

    const shouldSendMove = moved > 0.05 && (
        Math.abs(newX - lastMoveSentX) > 0.35 ||
        Math.abs(newY - lastMoveSentY) > 0.35 ||
        Date.now() - lastMoveSendAt > 90
    );
    if (shouldSendMove) {
        lastMoveSendAt = Date.now();
        lastMoveSentX = newX;
        lastMoveSentY = newY;
        sendWs({ type: 'move', x: newX, y: newY, animation: anim, sprinting: isSprinting && !inWater });
    }

    // Smooth camera lerp
    camTargetX = Math.max(0, Math.min(MAP_W * TILE - CAM_W, myPlayer.x - CAM_W / 2 + playerVelX * 10));
    camTargetY = Math.max(0, Math.min(MAP_H * TILE - CAM_H, myPlayer.y - CAM_H / 2 + playerVelY * 10));
    camX += (camTargetX - camX) * CAM_LERP;
    camY += (camTargetY - camY) * CAM_LERP;
    // Apply screen shake
    camX += shakeOffsetX;
    camY += shakeOffsetY;

    // Mouse world pos
    mouseWorldX = mouseX + camX;
    mouseWorldY = mouseY + camY;

    // Fog of war — reveal tiles around player
    const fogTx = Math.floor(myPlayer.x / TILE), fogTy = Math.floor(myPlayer.y / TILE);
    revealFog(fogTx, fogTy);
    // Periodically save explored tiles (every ~5 seconds)
    if (Date.now() % 5000 < 20) saveExploredTiles();

    // Build mode ghost
    if (buildMode) {
        ghostTileX = Math.floor(mouseWorldX / TILE);
        ghostTileY = Math.floor(mouseWorldY / TILE);
    }

    // Clean depleted nodes
    const now = Date.now();
    for (const [key, t] of depletedNodes) {
        if (now >= t) depletedNodes.delete(key);
    }

    // Panel slide animation
    updatePanelAnimation();
}

// ══════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════

function render() {
    const ctx = gameCtx;
    ctx.clearRect(0, 0, CAM_W, CAM_H);
    if (!myPlayer || !biomeCacheReady) {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, CAM_W, CAM_H);
        ctx.fillStyle = '#fff';
        ctx.font = '24px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Loading world...', CAM_W / 2, CAM_H / 2);
        return;
    }

    // Viewport tile range
    const startTX = Math.max(0, Math.floor(camX / TILE) - 1);
    const startTY = Math.max(0, Math.floor(camY / TILE) - 1);
    const endTX = Math.min(MAP_W - 1, Math.floor((camX + CAM_W) / TILE) + 1);
    const endTY = Math.min(MAP_H - 1, Math.floor((camY + CAM_H) / TILE) + 1);

    // Build a set of NPC building tiles for fast lookup
    const npcBuildSet = new Set();
    for (const npc of NPCS) {
        for (const [bx, by] of (npc.buildTiles || [])) npcBuildSet.add(`${bx},${by}`);
    }

    // Draw terrain
    for (let ty = startTY; ty <= endTY; ty++) {
        for (let tx = startTX; tx <= endTX; tx++) {
            const biome = getBiomeAt(tx, ty, worldSeed);
            const sx = tx * TILE - camX, sy = ty * TILE - camY;
            const key = `${tx},${ty}`;

            // Inter-town road tiles render as cobblestone regardless of biome
            if (townPathSet.has(key)) {
                ctx.fillStyle = '#8a8278';
                ctx.fillRect(sx, sy, TILE, TILE);
                ctx.fillStyle = '#7a7268';
                ctx.fillRect(sx + 2, sy + 2, 12, 10);
                ctx.fillRect(sx + 16, sy + 3, 14, 9);
                ctx.fillRect(sx + 4, sy + 16, 10, 12);
                ctx.fillRect(sx + 18, sy + 15, 12, 13);
                ctx.strokeStyle = 'rgba(0,0,0,0.1)';
                ctx.strokeRect(sx, sy, TILE, TILE);
            } else if (biome === 'outpost') {
                if (npcBuildSet.has(key)) {
                    // Building interior floor — skip, will be drawn by building renderer
                    ctx.fillStyle = '#7a9a5e';
                    ctx.fillRect(sx, sy, TILE, TILE);
                } else {
                    // Town grass — slightly varied
                    const gv = hashNoise(tx, ty, worldSeed + 999);
                    const g = Math.floor(90 + gv * 30);
                    ctx.fillStyle = `rgb(${80 + gv * 20}, ${g + 40}, ${60 + gv * 15})`;
                    ctx.fillRect(sx, sy, TILE, TILE);
                    // Subtle grass texture
                    if (gv > 0.7) {
                        ctx.fillStyle = 'rgba(34,180,50,0.3)';
                        ctx.fillRect(sx + 8, sy + 6, 2, 6);
                        ctx.fillRect(sx + 20, sy + 14, 2, 5);
                    }
                }
                // No grid lines in town — cleaner look
            } else {
                ctx.fillStyle = BIOME_COLORS[biome] || '#333';
                ctx.fillRect(sx, sy, TILE, TILE);
                ctx.strokeStyle = 'rgba(0,0,0,0.08)';
                ctx.strokeRect(sx, sy, TILE, TILE);
            }
        }
    }

    // Draw town decorations
    for (const deco of townDeco) {
        const dx = deco.tileX * TILE - camX, dy = deco.tileY * TILE - camY;
        if (dx < -TILE * 2 || dy < -TILE * 2 || dx > CAM_W + TILE * 2 || dy > CAM_H + TILE * 2) continue;
        drawTownDecoration(ctx, deco, dx, dy);
    }

    // Draw resource nodes
    const hoverTileX = Math.floor(mouseWorldX / TILE);
    const hoverTileY = Math.floor(mouseWorldY / TILE);
    for (let ty = startTY; ty <= endTY; ty++) {
        for (let tx = startTX; tx <= endTX; tx++) {
            const node = getResourceNodeAt(tx, ty, worldSeed);
            if (!node) continue;
            const depleted = depletedNodes.has(`${tx},${ty}`);
            const sx = tx * TILE - camX + TILE / 2;
            const sy = ty * TILE - camY + TILE / 2;
            ctx.globalAlpha = depleted ? 0.25 : 1;
            if (node.type === 'tree') drawTree(ctx, sx, sy, tx, ty);
            else if (node.type === 'rock') drawRock(ctx, sx, sy, node.ore, tx, ty);
            ctx.globalAlpha = 1;

            // Hover highlight when mouse is over a non-depleted node
            if (!depleted && !buildMode && tx === hoverTileX && ty === hoverTileY) {
                ctx.save();
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 3]);
                ctx.strokeRect(tx * TILE - camX + 1, ty * TILE - camY + 1, TILE - 2, TILE - 2);
                ctx.setLineDash([]);
                // Show "Click" hint
                ctx.fillStyle = '#fbbf24';
                ctx.font = 'bold 8px sans-serif';
                ctx.textAlign = 'center';
                const hint = node.type === 'rock' ? `⛏️ ${(ORE_NODE_TYPES[node.ore] || {}).name || 'Mine'}` : '🪓 Chop';
                ctx.fillText(hint, sx, sy - 14);
                ctx.restore();
            }
        }
    }

    // Draw structures
    for (const s of structures) {
        const sx = s.tile_x * TILE - camX, sy = s.tile_y * TILE - camY;
        if (sx < -TILE || sy < -TILE || sx > CAM_W + TILE || sy > CAM_H + TILE) continue;
        drawStructure(ctx, s, sx, sy);
    }

    // Draw build ghost
    if (buildMode && selectedStructure) {
        const sx = ghostTileX * TILE - camX, sy = ghostTileY * TILE - camY;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#55ff55';
        ctx.fillRect(sx, sy, TILE, TILE);
        ctx.font = '20px serif';
        ctx.textAlign = 'center';
        ctx.fillText(getStructureEmoji(selectedStructure), sx + TILE / 2, sy + TILE / 2 + 6);
        ctx.globalAlpha = 1;
    }

    // Draw NPC buildings (proper buildings with walls, roof, windows, door)
    for (const npc of NPCS) {
        const buildTiles = npc.buildTiles || [];
        if (buildTiles.length < 4) continue;

        // Get building bounds
        const allX = buildTiles.map(t => t[0]), allY = buildTiles.map(t => t[1]);
        const minX = Math.min(...allX), maxX = Math.max(...allX);
        const minY = Math.min(...allY), maxY = Math.max(...allY);
        const bsx = minX * TILE - camX, bsy = minY * TILE - camY;
        const bw = (maxX - minX + 1) * TILE, bh = (maxY - minY + 1) * TILE;

        if (bsx < -bw - 32 || bsy < -bh - 48 || bsx > CAM_W + 32 || bsy > CAM_H + 32) continue;

        drawNPCBuilding(ctx, npc, bsx, bsy, bw, bh, minX, minY, maxX, maxY);
    }

    // Draw NPC shopkeepers (on top of buildings)
    for (const npc of NPCS) {
        const nx = npc.tileX * TILE - camX, ny = npc.tileY * TILE - camY;
        if (nx < -TILE * 2 || ny < -TILE * 2 || nx > CAM_W + TILE * 2 || ny > CAM_H + TILE * 2) continue;
        const near = isNearNPC(npc);

        // NPC character (standing inside building, visible through door)
        const ncx = nx + TILE / 2, ncy = ny + TILE / 2;

        // Character body (simple RPG-style sprite)
        // Head
        ctx.fillStyle = '#fcd5b0';
        ctx.beginPath();
        ctx.arc(ncx, ncy - 6, 6, 0, Math.PI * 2);
        ctx.fill();
        // Body (colored apron/outfit)
        const outfitColors = { banker: '#2563eb', weaponsmith: '#dc2626', toolshop: '#78716c', farmsupply: '#16a34a', gemtrader: '#7c3aed', cosmetics: '#ec4899', cook: '#ea580c' };
        ctx.fillStyle = outfitColors[npc.id] || '#666';
        ctx.fillRect(ncx - 5, ncy, 10, 10);
        // Arms
        ctx.fillRect(ncx - 8, ncy + 1, 3, 7);
        ctx.fillRect(ncx + 5, ncy + 1, 3, 7);

        // Shop sign above building
        const signText = npc.emoji + ' ' + npc.name;
        ctx.font = 'bold 10px sans-serif';
        const tw = ctx.measureText(signText).width;
        const signX = nx + TILE / 2 - tw / 2 - 6;
        const buildTiles = npc.buildTiles || [];
        const topY = Math.min(...buildTiles.map(t => t[1]));
        const signY = topY * TILE - camY - 28;

        // Sign board
        ctx.fillStyle = 'rgba(30,20,10,0.9)';
        const signW = tw + 12, signH = 16;
        ctx.beginPath();
        ctx.roundRect(signX, signY, signW, signH, 3);
        ctx.fill();
        ctx.strokeStyle = '#8a7a5a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(signX, signY, signW, signH, 3);
        ctx.stroke();
        ctx.fillStyle = near ? '#fbbf24' : '#e8dcc8';
        ctx.textAlign = 'center';
        ctx.fillText(signText, nx + TILE / 2, signY + 12);

        // Interaction prompt
        if (near) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            const promptW = 110, promptH = 20;
            const doorTile = npc.doorTile || [npc.tileX, npc.tileY];
            const doorSX = doorTile[0] * TILE - camX, doorSY = doorTile[1] * TILE - camY;
            ctx.beginPath();
            ctx.roundRect(doorSX + TILE / 2 - promptW / 2, doorSY + TILE + 4, promptW, promptH, 4);
            ctx.fill();
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('[E] Enter Shop', doorSX + TILE / 2, doorSY + TILE + 18);
        }
    }

    // Draw other players
    for (const [uid, p] of Object.entries(players)) {
        if (String(uid) === String(myUserId)) continue;
        const px = p.x - camX, py = p.y - camY;
        if (px < -40 || py < -40 || px > CAM_W + 40 || py > CAM_H + 40) continue;
        drawPlayer(ctx, p, px, py, false);
    }

    // Draw self
    if (myPlayer) {
        const px = myPlayer.x - camX, py = myPlayer.y - camY;
        drawPlayer(ctx, myPlayer, px, py, true);
        // Dodge flash overlay
        if (dodgeFlashTimer > 0) {
            ctx.save();
            ctx.globalAlpha = Math.min(0.5, dodgeFlashTimer / 300);
            ctx.fillStyle = '#60a5fa';
            ctx.beginPath();
            ctx.arc(px, py, 18, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        // Tool/weapon swing arc animation
        if (swingAnim > 0) {
            ctx.save();
            ctx.translate(px, py);
            // Vary swing visual by type
            let swingColor, swingRadius, swingIcon;
            if (swingType === 'mine') {
                swingColor = 'rgba(251, 191, 36, 0.8)'; swingRadius = 24; swingIcon = '⛏️';
            } else if (swingType === 'chop') {
                swingColor = 'rgba(74, 222, 128, 0.8)'; swingRadius = 22; swingIcon = '🪓';
            } else if (swingType === 'punch') {
                swingColor = 'rgba(239, 68, 68, 0.7)'; swingRadius = 16; swingIcon = '👊';
            } else {
                swingColor = 'rgba(255, 255, 255, 0.7)'; swingRadius = 22; swingIcon = null;
            }
            ctx.rotate(facingAngle - Math.PI / 4 + swingAnim * Math.PI / 2);
            ctx.strokeStyle = swingColor;
            ctx.lineWidth = swingType === 'punch' ? 4 : 3;
            ctx.beginPath();
            ctx.arc(0, 0, swingRadius, -0.3, 0.8);
            ctx.stroke();
            // Tool icon at arc tip
            if (swingIcon && swingAnim > 0.4) {
                ctx.font = '12px serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#fff';
                const tipAngle = 0.8;
                ctx.fillText(swingIcon, Math.cos(tipAngle) * swingRadius, Math.sin(tipAngle) * swingRadius);
            }
            ctx.restore();
        }
    }

    // Draw world mobs
    for (const [mid, mob] of Object.entries(mobs)) {
        const mx = mob.x - camX, my = mob.y - camY;
        if (mx < -40 || my < -40 || mx > CAM_W + 40 || my > CAM_H + 40) continue;
        drawMob(ctx, mob, mx, my);
    }

    // Draw ground items (bobbing animation)
    const bobTime = Date.now() / 400;
    for (const [gid, gi] of Object.entries(groundItems)) {
        const gx = gi.x - camX, gy = gi.y - camY;
        if (gx < -20 || gy < -20 || gx > CAM_W + 20 || gy > CAM_H + 20) continue;
        const bobY = Math.sin(bobTime + gi.x * 0.1) * 3;
        // Glow circle
        const rarCol = RARITY_COLORS[gi.rarity] || '#b0b0b0';
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = rarCol;
        ctx.beginPath();
        ctx.arc(gx, gy + bobY, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Item emoji
        ctx.font = '14px serif';
        ctx.textAlign = 'center';
        ctx.fillText(gi.emoji || '📦', gx, gy + bobY + 5);
        // Quantity badge
        if (gi.qty > 1) {
            ctx.font = 'bold 8px sans-serif';
            ctx.fillStyle = '#fff';
            ctx.fillText(`x${gi.qty}`, gx + 8, gy + bobY - 4);
        }
        // Pickup prompt when close
        if (myPlayer) {
            const dist = Math.sqrt((gi.x - myPlayer.x) ** 2 + (gi.y - myPlayer.y) ** 2);
            if (dist < TILE * 2.5) {
                ctx.font = 'bold 8px sans-serif';
                ctx.fillStyle = '#fbbf24';
                ctx.fillText('[E] Pick up', gx, gy + bobY - 10);
            }
        }
        ctx.restore();
    }

    // Draw treasure chests (animated glow)
    const chestBob = Date.now() / 500;
    const tierGlow = { wooden: '#a0845c', silver: '#94a3b8', gold: '#fbbf24', crystal: '#a78bfa' };
    for (const [cid, ch] of Object.entries(chests)) {
        const cx = ch.x - camX, cy = ch.y - camY;
        if (cx < -20 || cy < -20 || cx > CAM_W + 20 || cy > CAM_H + 20) continue;
        const bob = Math.sin(chestBob + ch.x * 0.05) * 2;
        // Glow pulse
        const pulse = 0.3 + 0.15 * Math.sin(Date.now() / 300 + ch.id);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.fillStyle = tierGlow[ch.tier] || '#fbbf24';
        ctx.beginPath();
        ctx.arc(cx, cy + bob, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Chest emoji
        ctx.font = '18px serif';
        ctx.textAlign = 'center';
        ctx.fillText(ch.emoji || '📦', cx, cy + bob + 6);
        // Tier label
        ctx.font = 'bold 7px sans-serif';
        ctx.fillStyle = tierGlow[ch.tier] || '#fbbf24';
        ctx.fillText(ch.tier.toUpperCase(), cx, cy + bob - 10);
        // Open prompt when close
        if (myPlayer) {
            const dist = Math.sqrt((ch.x - myPlayer.x) ** 2 + (ch.y - myPlayer.y) ** 2);
            if (dist < TILE * 3) {
                ctx.font = 'bold 8px sans-serif';
                ctx.fillStyle = '#fbbf24';
                ctx.fillText('[Click] Open', cx, cy + bob - 18);
            }
        }
        ctx.restore();
    }

    // Draw death drop scatter animations
    deathDropAnims = deathDropAnims.filter(d => {
        d.progress = Math.min(1, d.progress + 0.04);
        d.life--;
        // Ease-out curve
        const t = 1 - Math.pow(1 - d.progress, 3);
        const x = d.startX + (d.targetX - d.startX) * t;
        const y = d.startY + (d.targetY - d.startY) * t - Math.sin(t * Math.PI) * 30; // arc trajectory
        const sx = x - camX, sy = y - camY;
        if (sx > -30 && sy > -30 && sx < CAM_W + 30 && sy < CAM_H + 30) {
            ctx.save();
            ctx.globalAlpha = d.life > 10 ? 1 : d.life / 10;
            ctx.font = '16px serif';
            ctx.textAlign = 'center';
            ctx.fillText(d.emoji, sx, sy);
            ctx.restore();
        }
        return d.life > 0;
    });

    // Floating effects
    drawEffects(ctx);

    // HUD
    drawHUD(ctx);

    // Hotbar
    drawHotbar(ctx);

    // Day/Night overlay
    drawDayNight(ctx);

    // Weather overlay
    drawWeather(ctx);

    // Achievement toasts
    drawAchievementToasts(ctx);

    // Minimap
    drawMinimap(ctx);

    // Chat overlay
    drawChat(ctx);

    // Active panel (draw during close animation too)
    if (activePanel || panelAnimDir !== 0) drawPanel(ctx);

    // Fishing mini-game overlay
    if (FISHING.active) renderFishingOverlay(ctx);

    // Death screen
    if (isDead) drawDeathScreen(ctx);
}

// ── Drawing helpers ──────────────────────────────────────────

// ── Town building renderer (Zelda/Pokemon style) ─────────────
function drawNPCBuilding(ctx, npc, bsx, bsy, bw, bh, minTX, minTY, maxTX, maxTY) {
    const roofColor = npc.roofColor || '#6b4423';
    const wallColor = '#e8dcc0';
    const wallDark  = '#c8b898';
    const doorTile  = npc.doorTile || [npc.tileX, npc.tileY];
    const cols = maxTX - minTX + 1;
    const rows = maxTY - minTY + 1;

    // Foundation / shadow
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(bsx + 3, bsy + bh - 2, bw, 5);

    // Wall base (stucco/plaster look)
    ctx.fillStyle = wallColor;
    ctx.fillRect(bsx, bsy + 8, bw, bh - 8);

    // Wall edge lines (stone trim)
    ctx.strokeStyle = wallDark;
    ctx.lineWidth = 2;
    ctx.strokeRect(bsx + 1, bsy + 8, bw - 2, bh - 9);

    // Horizontal stone band at two levels
    ctx.fillStyle = '#b8a888';
    ctx.fillRect(bsx, bsy + 8, bw, 3);
    ctx.fillRect(bsx, bsy + bh - 3, bw, 3);

    // Windows (on upper wall — row 1 of building, skip door column)
    const doorCol = doorTile[0] - minTX;
    for (let c = 0; c < cols; c++) {
        const wx = bsx + c * TILE;
        // Window on upper rows only (not ground floor which is door row-ish)
        if (rows >= 3) {
            // Row 1 windows
            const wy = bsy + TILE + 2;
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(wx + 8, wy + 4, 16, 14);
            // Window frame
            ctx.strokeStyle = '#8a7a5a';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(wx + 7, wy + 3, 18, 16);
            // Cross divider
            ctx.beginPath();
            ctx.moveTo(wx + 16, wy + 4); ctx.lineTo(wx + 16, wy + 18);
            ctx.moveTo(wx + 8, wy + 11); ctx.lineTo(wx + 24, wy + 11);
            ctx.stroke();
            // Warm interior glow
            ctx.fillStyle = 'rgba(255,200,100,0.2)';
            ctx.fillRect(wx + 9, wy + 5, 14, 12);
        }
    }

    // Door (bottom center tile of building)
    const doorSX = doorTile[0] * TILE - camX;
    const doorSY = doorTile[1] * TILE - camY;
    // Door frame
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(doorSX + 6, doorSY - 2, 20, TILE + 2);
    // Door itself (warm wood)
    ctx.fillStyle = '#8b6914';
    ctx.fillRect(doorSX + 8, doorSY, 16, TILE - 2);
    // Door panels
    ctx.strokeStyle = '#6b5010';
    ctx.lineWidth = 1;
    ctx.strokeRect(doorSX + 10, doorSY + 2, 12, 10);
    ctx.strokeRect(doorSX + 10, doorSY + 14, 12, 12);
    // Door handle
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(doorSX + 20, doorSY + 16, 2, 0, Math.PI * 2);
    ctx.fill();
    // Welcome mat
    ctx.fillStyle = '#8b5e3c';
    ctx.fillRect(doorSX + 4, doorSY + TILE - 4, 24, 4);

    // Peaked roof
    const roofOverhang = 6;
    const roofPeakH = 20;
    ctx.fillStyle = roofColor;
    ctx.beginPath();
    ctx.moveTo(bsx - roofOverhang, bsy + 10);
    ctx.lineTo(bsx + bw / 2, bsy - roofPeakH);
    ctx.lineTo(bsx + bw + roofOverhang, bsy + 10);
    ctx.closePath();
    ctx.fill();

    // Roof highlight (lighter ridge)
    ctx.strokeStyle = lightenColor(roofColor, 30);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bsx - roofOverhang + 3, bsy + 9);
    ctx.lineTo(bsx + bw / 2, bsy - roofPeakH + 3);
    ctx.lineTo(bsx + bw + roofOverhang - 3, bsy + 9);
    ctx.stroke();

    // Roof shadow line at base
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(bsx - roofOverhang, bsy + 8, bw + roofOverhang * 2, 4);

    // Chimney (on some buildings)
    if (npc.id === 'cook' || npc.id === 'weaponsmith') {
        const chimX = bsx + bw - 20, chimY = bsy - roofPeakH + 4;
        ctx.fillStyle = '#6b5c50';
        ctx.fillRect(chimX, chimY, 10, roofPeakH);
        ctx.fillStyle = '#8a7a6a';
        ctx.fillRect(chimX - 1, chimY - 2, 12, 4);
        // Smoke particles
        const t = Date.now() / 800;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#aaa';
        for (let i = 0; i < 3; i++) {
            const smokeY = chimY - 8 - i * 10 - (t % 1) * 8;
            const smokeX = chimX + 5 + Math.sin(t + i) * 4;
            ctx.beginPath();
            ctx.arc(smokeX, smokeY, 3 + i, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

function lightenColor(hex, amount) {
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
    return `rgb(${r},${g},${b})`;
}

// ── Town decoration renderer ─────────────────────────────────
function drawTownDecoration(ctx, deco, dx, dy) {
    const cx = dx + TILE / 2, cy = dy + TILE / 2;
    switch (deco.type) {
        case 'fountain': {
            // Stone base
            ctx.fillStyle = '#8a8278';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 14, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#6a6258';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 14, 8, 0, 0, Math.PI * 2);
            ctx.stroke();
            // Water
            ctx.fillStyle = 'rgba(59,130,246,0.5)';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 11, 6, 0, 0, Math.PI * 2);
            ctx.fill();
            // Center spout
            ctx.fillStyle = '#7a7268';
            ctx.fillRect(cx - 2, cy - 8, 4, 12);
            // Water spray (animated)
            const t = Date.now() / 300;
            ctx.fillStyle = 'rgba(147,197,253,0.7)';
            for (let i = 0; i < 5; i++) {
                const a = (t + i * 1.26) % (Math.PI * 2);
                const sx = cx + Math.cos(a) * 6;
                const sy = cy - 8 + Math.sin(a) * 3 - 2;
                ctx.beginPath();
                ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case 'lamp': {
            // Post
            ctx.fillStyle = '#4a4a4a';
            ctx.fillRect(cx - 1.5, cy - 4, 3, 16);
            // Lamp head
            ctx.fillStyle = '#6a6a6a';
            ctx.fillRect(cx - 4, cy - 6, 8, 4);
            // Glow (brighter at night)
            const nightAlpha = Math.max(0.15, (1 - Math.abs(dayTime - 0.5) * 2) * 0.5);
            ctx.fillStyle = `rgba(255,220,130,${nightAlpha})`;
            ctx.beginPath();
            ctx.arc(cx, cy - 4, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffe066';
            ctx.beginPath();
            ctx.arc(cx, cy - 4, 3, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
        case 'bench': {
            ctx.fillStyle = '#8b6914';
            ctx.fillRect(cx - 10, cy, 20, 6);
            ctx.fillStyle = '#654a0e';
            ctx.fillRect(cx - 8, cy + 6, 3, 5);
            ctx.fillRect(cx + 5, cy + 6, 3, 5);
            // Back rest
            ctx.fillStyle = '#8b6914';
            ctx.fillRect(cx - 10, cy - 4, 20, 4);
            break;
        }
        case 'flowers': {
            const colors = ['#ef4444', '#f59e0b', '#ec4899', '#a855f7', '#3b82f6'];
            for (let i = 0; i < 6; i++) {
                const fx = cx - 8 + (i % 3) * 8, fy = cy - 2 + Math.floor(i / 3) * 8;
                // Stem
                ctx.fillStyle = '#22c55e';
                ctx.fillRect(fx, fy + 3, 1.5, 5);
                // Petal
                ctx.fillStyle = colors[i % colors.length];
                ctx.beginPath();
                ctx.arc(fx, fy + 2, 3, 0, Math.PI * 2);
                ctx.fill();
                // Center
                ctx.fillStyle = '#fbbf24';
                ctx.beginPath();
                ctx.arc(fx, fy + 2, 1.2, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case 'sign': {
            // Post
            ctx.fillStyle = '#78350f';
            ctx.fillRect(cx - 1.5, cy - 2, 3, 14);
            // Sign board
            ctx.fillStyle = '#92702e';
            ctx.fillRect(cx - 14, cy - 10, 28, 12);
            ctx.strokeStyle = '#5c4518';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx - 14, cy - 10, 28, 12);
            // Text
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(deco.text || 'Town', cx, cy - 2);
            break;
        }
        case 'town_tree': {
            // Larger, rounder decorative tree (different from wild trees)
            ctx.fillStyle = '#78350f';
            ctx.fillRect(cx - 3, cy + 2, 6, 10);
            // Lush round canopy
            ctx.fillStyle = '#1a7a2e';
            ctx.beginPath();
            ctx.arc(cx, cy - 4, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22a03a';
            ctx.beginPath();
            ctx.arc(cx - 3, cy - 6, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx + 4, cy - 3, 6, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
        case 'barrel': {
            ctx.fillStyle = '#8b5a2b';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 2, 8, 10, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#5a3a1a';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(cx, cy - 2, 7, 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.ellipse(cx, cy + 6, 7, 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            // Metal band
            ctx.strokeStyle = '#888';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 2, 8, 3, 0, 0, Math.PI * 2);
            ctx.stroke();
            break;
        }
        case 'crate': {
            ctx.fillStyle = '#a87832';
            ctx.fillRect(cx - 9, cy - 7, 18, 16);
            ctx.strokeStyle = '#6b4e20';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(cx - 9, cy - 7, 18, 16);
            // Cross straps
            ctx.beginPath();
            ctx.moveTo(cx - 9, cy - 7); ctx.lineTo(cx + 9, cy + 9);
            ctx.moveTo(cx + 9, cy - 7); ctx.lineTo(cx - 9, cy + 9);
            ctx.stroke();
            break;
        }
        case 'well': {
            // Stone base
            ctx.fillStyle = '#7a7268';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 12, 7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#5a5248';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 12, 7, 0, 0, Math.PI * 2);
            ctx.stroke();
            // Water inside
            ctx.fillStyle = 'rgba(30,64,175,0.5)';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 4, 8, 5, 0, 0, Math.PI * 2);
            ctx.fill();
            // Posts
            ctx.fillStyle = '#654a0e';
            ctx.fillRect(cx - 10, cy - 10, 3, 14);
            ctx.fillRect(cx + 7, cy - 10, 3, 14);
            // Crossbeam
            ctx.fillRect(cx - 10, cy - 12, 20, 3);
            // Bucket
            ctx.fillStyle = '#8a7a5a';
            ctx.fillRect(cx - 3, cy - 8, 6, 5);
            break;
        }
    }
}

// ── Seeded PRNG for deterministic per-node variation ──
function nodeRng(tx, ty, i) {
    let h = (tx * 374761 + ty * 668265 + i * 93481) | 0;
    h = ((h >> 16) ^ h) * 0x45d9f3b | 0;
    h = ((h >> 16) ^ h) * 0x45d9f3b | 0;
    return ((h >> 16) ^ h & 0x7fffffff) / 0x7fffffff;
}

function drawTree(ctx, cx, cy, tx, ty) {
    tx = tx || 0; ty = ty || 0;
    const r0 = nodeRng(tx, ty, 0);
    const r1 = nodeRng(tx, ty, 1);
    const r2 = nodeRng(tx, ty, 2);
    const r3 = nodeRng(tx, ty, 3);
    const r4 = nodeRng(tx, ty, 4);
    const r5 = nodeRng(tx, ty, 5);

    const trunkH = 7 + r0 * 5;              // 7-12
    const canopyR = 8 + r1 * 6;             // 8-14
    const lean = (r2 - 0.5) * 3;             // slight lean
    const treeHue = 100 + r3 * 35;          // 100-135 (green range)
    const treeSat = 45 + r4 * 25;

    ctx.save();
    ctx.translate(cx + lean * 0.3, cy);

    // Shadow on ground
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.beginPath();
    ctx.ellipse(0, 8, canopyR * 0.7, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Trunk
    const trunkW = 2 + r5 * 1.5;
    ctx.fillStyle = `hsl(28, 45%, ${22 + r0 * 10}%)`;
    ctx.beginPath();
    ctx.moveTo(-trunkW, 6);
    ctx.lineTo(-trunkW * 0.6 + lean * 0.2, 6 - trunkH);
    ctx.lineTo(trunkW * 0.6 + lean * 0.2, 6 - trunkH);
    ctx.lineTo(trunkW, 6);
    ctx.closePath();
    ctx.fill();

    // Canopy layers (2-3 overlapping circles for a lush look)
    const layers = 2 + Math.floor(r2 * 2);
    for (let i = 0; i < layers; i++) {
        const ri = nodeRng(tx, ty, 10 + i);
        const offsetX = (ri - 0.5) * canopyR * 0.5;
        const offsetY = -trunkH - canopyR * 0.3 + i * 2.5;
        const layerR = canopyR * (1 - i * 0.15);
        const lightness = 28 + i * 6 + ri * 8;

        ctx.fillStyle = `hsl(${treeHue}, ${treeSat}%, ${lightness}%)`;
        ctx.beginPath();
        ctx.ellipse(offsetX + lean * 0.15, offsetY, layerR, layerR * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // Highlight on top canopy
    ctx.fillStyle = `hsla(${treeHue + 10}, ${treeSat + 10}%, 55%, 0.35)`;
    ctx.beginPath();
    ctx.ellipse(lean * 0.15 - 2, -trunkH - canopyR * 0.45, canopyR * 0.4, canopyR * 0.35, -0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawRock(ctx, cx, cy, oreType, tx, ty) {
    tx = tx || 0; ty = ty || 0;
    const ore = ORE_NODE_TYPES[oreType] || ORE_NODE_TYPES.stone;
    const t = Date.now() / 1000;

    // Per-node deterministic random values
    const r0 = nodeRng(tx, ty, 0);
    const r1 = nodeRng(tx, ty, 1);
    const r2 = nodeRng(tx, ty, 2);
    const r3 = nodeRng(tx, ty, 3);
    const r4 = nodeRng(tx, ty, 4);
    const r5 = nodeRng(tx, ty, 5);
    const r6 = nodeRng(tx, ty, 6);

    ctx.save();
    ctx.translate(cx, cy);

    const isRare = ['gold', 'mithril', 'titanium', 'platinum', 'dragonite'].includes(oreType);
    const isLegendary = ['dragonite', 'platinum'].includes(oreType);

    // Outer glow for rare ores
    if (isRare) {
        const glowPulse = 0.3 + Math.sin(t * 2.2 + r0 * 6) * 0.15;
        ctx.shadowColor = ore.highlight;
        ctx.shadowBlur = isLegendary ? 14 + Math.sin(t * 3) * 4 : 8 + Math.sin(t * 2) * 3;
        ctx.globalAlpha = glowPulse;
        ctx.fillStyle = ore.highlight;
        ctx.beginPath();
        ctx.ellipse(0, 0, 13, 9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }

    // Base rock shape — irregular polygon instead of simple ellipse
    const rockPoints = [];
    const numVertices = 6 + Math.floor(r0 * 3); // 6-8 vertices
    const baseRx = 9 + r1 * 4;   // 9-13
    const baseRy = 6 + r2 * 3;   // 6-9
    for (let i = 0; i < numVertices; i++) {
        const angle = (Math.PI * 2 / numVertices) * i;
        const wobble = 0.75 + nodeRng(tx, ty, 20 + i) * 0.5;
        rockPoints.push({
            x: Math.cos(angle) * baseRx * wobble,
            y: Math.sin(angle) * baseRy * wobble,
        });
    }

    // Rock base gradient
    const grad = ctx.createRadialGradient(-2, -2, 1, 0, 0, baseRx);
    grad.addColorStop(0, ore.highlight);
    grad.addColorStop(0.6, ore.color);
    grad.addColorStop(1, darkenColor(ore.color, 0.6));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(rockPoints[0].x, rockPoints[0].y);
    for (let i = 1; i < rockPoints.length; i++) {
        const prev = rockPoints[i - 1];
        const curr = rockPoints[i];
        const cpx = (prev.x + curr.x) / 2 + (nodeRng(tx, ty, 30 + i) - 0.5) * 2;
        const cpy = (prev.y + curr.y) / 2 + (nodeRng(tx, ty, 40 + i) - 0.5) * 2;
        ctx.quadraticCurveTo(cpx, cpy, curr.x, curr.y);
    }
    ctx.closePath();
    ctx.fill();

    // Rock outline / edge shading
    ctx.strokeStyle = darkenColor(ore.color, 0.45);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Inner crack/vein lines for detail
    ctx.strokeStyle = darkenColor(ore.color, 0.35);
    ctx.lineWidth = 0.7;
    const numCracks = 2 + Math.floor(r3 * 2);
    for (let i = 0; i < numCracks; i++) {
        const ri = nodeRng(tx, ty, 50 + i);
        const ri2 = nodeRng(tx, ty, 60 + i);
        const startAngle = ri * Math.PI * 2;
        const len = 3 + ri2 * 5;
        const sx = Math.cos(startAngle) * 2;
        const sy = Math.sin(startAngle) * 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(startAngle + 0.3) * len, sy + Math.sin(startAngle + 0.3) * len * 0.6);
        ctx.stroke();
    }

    // Specular highlight
    ctx.fillStyle = `rgba(255,255,255,${0.15 + r4 * 0.1})`;
    ctx.beginPath();
    ctx.ellipse(-2 + r5 * 2, -2 + r6 * 2, 3 + r4 * 2, 2 + r5, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // ── Ore-specific decorations ──
    if (oreType && oreType !== 'stone') {
        // Crystal/ore vein deposits on the rock face
        const numCrystals = oreType === 'dragonite' ? 4 : oreType === 'platinum' || oreType === 'mithril' ? 3 : 2;
        for (let i = 0; i < numCrystals; i++) {
            const ci = nodeRng(tx, ty, 70 + i);
            const ci2 = nodeRng(tx, ty, 80 + i);
            const ci3 = nodeRng(tx, ty, 90 + i);
            const angle = (Math.PI * 2 / numCrystals) * i + ci * 0.8;
            const dist = 2 + ci2 * (baseRx * 0.45);
            const csx = Math.cos(angle) * dist;
            const csy = Math.sin(angle) * dist * 0.65;
            const crystalH = 4 + ci3 * 4;
            const crystalW = 2 + ci * 2;

            // Crystal shape (pointed shard growing out of rock)
            ctx.save();
            ctx.translate(csx, csy);
            ctx.rotate(angle + Math.PI * 0.5 + (ci - 0.5) * 0.5);

            // Crystal body with gradient
            const crystalGrad = ctx.createLinearGradient(0, 0, 0, -crystalH);
            crystalGrad.addColorStop(0, ore.color);
            crystalGrad.addColorStop(0.5, ore.highlight);
            crystalGrad.addColorStop(1, lightenColor(ore.highlight, 0.3));
            ctx.fillStyle = crystalGrad;
            ctx.beginPath();
            ctx.moveTo(-crystalW, 0);
            ctx.lineTo(-crystalW * 0.3, -crystalH * 0.7);
            ctx.lineTo(0, -crystalH);
            ctx.lineTo(crystalW * 0.3, -crystalH * 0.7);
            ctx.lineTo(crystalW, 0);
            ctx.closePath();
            ctx.fill();

            // Crystal edge highlight
            ctx.strokeStyle = `rgba(255,255,255,${0.3 + Math.sin(t * 1.5 + i * 2) * 0.15})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(-crystalW * 0.3, -crystalH * 0.7);
            ctx.lineTo(0, -crystalH);
            ctx.lineTo(crystalW * 0.3, -crystalH * 0.7);
            ctx.stroke();

            ctx.restore();
        }

        // Animated sparkle / shimmer for valuable ores
        if (isRare) {
            const sparkleCount = isLegendary ? 4 : 2;
            for (let i = 0; i < sparkleCount; i++) {
                const si = nodeRng(tx, ty, 100 + i);
                const sparklePhase = t * (1.5 + si) + si * 10;
                const sparkleAlpha = Math.max(0, Math.sin(sparklePhase)) * 0.8;
                if (sparkleAlpha > 0.1) {
                    const sx = (si - 0.5) * baseRx * 1.5;
                    const sy = (nodeRng(tx, ty, 110 + i) - 0.5) * baseRy * 1.2;
                    const sparkleSize = 1.5 + Math.sin(sparklePhase) * 1;
                    ctx.fillStyle = `rgba(255,255,255,${sparkleAlpha.toFixed(2)})`;
                    // Star sparkle shape
                    ctx.beginPath();
                    ctx.moveTo(sx, sy - sparkleSize);
                    ctx.lineTo(sx + sparkleSize * 0.3, sy - sparkleSize * 0.3);
                    ctx.lineTo(sx + sparkleSize, sy);
                    ctx.lineTo(sx + sparkleSize * 0.3, sy + sparkleSize * 0.3);
                    ctx.lineTo(sx, sy + sparkleSize);
                    ctx.lineTo(sx - sparkleSize * 0.3, sy + sparkleSize * 0.3);
                    ctx.lineTo(sx - sparkleSize, sy);
                    ctx.lineTo(sx - sparkleSize * 0.3, sy - sparkleSize * 0.3);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        }

        // Ore type label
        ctx.font = 'bold 7px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = ore.highlight;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 2;
        ctx.strokeText(ore.name, 0, baseRy + 8);
        ctx.fillText(ore.name, 0, baseRy + 8);
        ctx.lineWidth = 1;
    }

    ctx.restore();
}

// ── Color helper utilities for ore rendering ──
function darkenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * amount)},${Math.round(g * amount)},${Math.round(b * amount)})`;
}
function lightenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.min(255, Math.round(r + (255 - r) * amount))},${Math.min(255, Math.round(g + (255 - g) * amount))},${Math.min(255, Math.round(b + (255 - b) * amount))})`;
}

function drawFishSpot(ctx, cx, cy) {
    ctx.fillStyle = '#60a5fa';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.globalAlpha *= 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha /= 0.6;
    ctx.font = '12px serif';
    ctx.textAlign = 'center';
    ctx.fillText('🐟', cx, cy + 4);
}

const STRUCTURE_EMOJIS = {
    wall_wood: '🟫', wall_stone: '🧱', door_wood: '🚪', floor_wood: '📋',
    workbench: '🔨', furnace: '🔥', storage_box: '📦', sleeping_bag: '🛏️',
    campfire: '🏕️', tool_cupboard: '🧰',
};
function getStructureEmoji(type) { return STRUCTURE_EMOJIS[type] || '🔲'; }

function drawStructure(ctx, s, sx, sy) {
    const isOwn = s.owner_id === myUserId;
    ctx.fillStyle = isOwn ? 'rgba(100,200,100,0.35)' : 'rgba(200,100,100,0.25)';
    ctx.fillRect(sx, sy, TILE, TILE);
    ctx.strokeStyle = isOwn ? '#4ade80' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
    ctx.font = '20px serif';
    ctx.textAlign = 'center';
    ctx.fillText(getStructureEmoji(s.type), sx + TILE / 2, sy + TILE / 2 + 6);
    // HP bar
    if (s.hp < s.max_hp) {
        const pct = s.hp / s.max_hp;
        ctx.fillStyle = '#333';
        ctx.fillRect(sx + 2, sy + TILE - 5, TILE - 4, 3);
        ctx.fillStyle = pct > 0.5 ? '#4ade80' : pct > 0.25 ? '#fbbf24' : '#ef4444';
        ctx.fillRect(sx + 2, sy + TILE - 5, (TILE - 4) * pct, 3);
    }
}

function drawPlayer(ctx, p, px, py, isSelf) {
    const bodyId = isSelf ? `self:${myUserId || 'local'}` : `remote:${p.userId || p.username || p.display_name || `${p.x},${p.y}`}`;
    const bodyState = updateMoveBodyState(bodyId, px, py, frameDeltaMs, { isRemote: !isSelf });
    const drawX = isSelf ? px : bodyState.renderX;
    const groundY = isSelf ? py : bodyState.renderY;
    // Jump offset — sprite rises while shadow stays at ground
    const jOff = isSelf ? jumpHeight : 0;
    const drawY = groundY - jOff;
    // Landing squash-stretch: scaleX widens, scaleY compresses
    const squashAmt = isSelf ? jumpSquashTimer / 8 : 0;
    const jumpScaleX = 1 + squashAmt * 0.2;
    const jumpScaleY = 1 - squashAmt * 0.15;

    const ptx = Math.floor((p.x ?? myPlayer?.x ?? 0) / TILE);
    const pty = Math.floor((p.y ?? myPlayer?.y ?? 0) / TILE);
    const inWater = worldSeed && getBiomeAt(ptx, pty, worldSeed) === 'water';

    let heldEmoji = null;
    if (isSelf) {
        heldEmoji = hotbarSlots[activeHotbarSlot]?.emoji || null;
    }
    if (!heldEmoji && !isSelf) {
        const wep = p.equip_weapon;
        if (wep) {
            if (wep.includes('legendary') || wep.includes('dragonslayer')) heldEmoji = '🐲';
            else if (wep.includes('katana')) heldEmoji = '🗡️';
            else if (wep === 'weapon_axe') heldEmoji = '🪓';
            else if (wep.includes('sword')) heldEmoji = '⚔️';
            else if (wep.includes('stick')) heldEmoji = '🏏';
            else if (wep.includes('rock')) heldEmoji = '🪨';
            else heldEmoji = '🔪';
        } else if (p.equip_pickaxe) heldEmoji = p.equip_pickaxe.includes('diamond') ? '💎' : p.equip_pickaxe.includes('gold') ? '✨' : '⛏️';
        else if (p.equip_axe) heldEmoji = '🪓';
        else if (p.equip_rod) heldEmoji = '🎣';
    }

    let aimAngle = isSelf ? facingAngle : Math.atan2((p.y ?? 0) - (p._prevY ?? p.y ?? 0), (p.x ?? 0) - (p._prevX ?? p.x ?? 0));
    if (!Number.isFinite(aimAngle)) aimAngle = 0;
    const forwardX = Math.cos(aimAngle);
    const forwardY = Math.sin(aimAngle);
    const rightX = -forwardY;
    const rightY = forwardX;
    const moveAmount = isSelf ? Math.min(1, Math.hypot(playerVelX, playerVelY) / 3.8) : bodyState.strideStrength;
    const stride = Math.sin(bodyState.stridePhase) * (4 + moveAmount * 4.5);
    const counterStride = Math.sin(bodyState.stridePhase + Math.PI) * (4 + moveAmount * 4.5);
    const torsoX = drawX + bodyState.torsoLeanX * 0.15;
    const torsoY = drawY + bodyState.torsoLeanY * 0.15 - 2 + bodyState.bob * 0.35;
    const hipsX = torsoX - forwardX * 2;
    const hipsY = torsoY + 7;
    const baseFootY = drawY + 12;
    const footColor = isSelf ? '#2563eb' : '#c62828';

    const leftFoot = {
        x: drawX + rightX * 5 + forwardX * stride,
        y: baseFootY + rightY * 5 + forwardY * stride,
        lift: Math.max(0, Math.sin(bodyState.stridePhase)) * (2 + moveAmount * 2.5),
    };
    const rightFoot = {
        x: drawX - rightX * 5 + forwardX * counterStride,
        y: baseFootY - rightY * 5 + forwardY * counterStride,
        lift: Math.max(0, Math.sin(bodyState.stridePhase + Math.PI)) * (2 + moveAmount * 2.5),
    };

    // Shadow (stays at ground level, shrinks when airborne)
    const shadowAlpha = Math.max(0.06, 0.22 - jOff * 0.006);
    const shadowScale = Math.max(0.5, 1 - jOff * 0.018);
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${shadowAlpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(drawX, groundY + 13, (10 + moveAmount * 2) * shadowScale, (4 + moveAmount) * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    // Jump dust particles (rendered at ground level)
    if (isSelf && jumpParticles.length > 0) {
        for (const dp of jumpParticles) {
            const alpha = (dp.life / dp.maxLife) * 0.6;
            ctx.fillStyle = `rgba(180,160,130,${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(drawX + dp.x, groundY + 10 + dp.y, dp.size * (dp.life / dp.maxLife), 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();

    if (inWater) {
        const rippleTime = Date.now() / 220;
        ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
        ctx.lineWidth = 1.3;
        for (let i = 0; i < 3; i++) {
            const r = 10 + i * 5 + Math.sin(rippleTime + i + bodyState.stridePhase * 0.2) * 2;
            ctx.beginPath();
            ctx.ellipse(drawX, drawY + 8, r, r * 0.36, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.save();
        ctx.translate(torsoX, torsoY + bodyState.headBob * 0.25);
        ctx.rotate(bodyState.torsoRoll * 0.5);
        ctx.beginPath();
        ctx.rect(-18, -28, 36, 30);
        ctx.clip();
        ctx.fillStyle = isSelf ? '#3b82f6' : '#ef4444';
        ctx.beginPath();
        ctx.ellipse(0, 0, 11, 12.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#f8d2b4';
        ctx.beginPath();
        ctx.arc(0, -10, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(96, 165, 250, 0.72)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🏊 Swimming', drawX, drawY + 25);
    } else {
        // Apply squash-stretch on landing
        if (squashAmt > 0.01) {
            ctx.save();
            ctx.translate(drawX, drawY + 12); // pivot at feet
            ctx.scale(jumpScaleX, jumpScaleY);
            ctx.translate(-drawX, -(drawY + 12));
        }

        // Legs and feet
        const drawLeg = (foot, side) => {
            const kneeX = (hipsX + foot.x) * 0.5 + side * rightX * 1.4;
            const kneeY = (hipsY + foot.y) * 0.5 + side * rightY * 1.4 - foot.lift;
            ctx.strokeStyle = 'rgba(10,10,18,0.65)';
            ctx.lineWidth = 2.1;
            ctx.beginPath();
            ctx.moveTo(hipsX + side * rightX * 2.5, hipsY + side * rightY * 2.5);
            ctx.lineTo(kneeX, kneeY);
            ctx.lineTo(foot.x, foot.y - foot.lift);
            ctx.stroke();

            ctx.fillStyle = footColor;
            ctx.beginPath();
            ctx.ellipse(foot.x, foot.y - foot.lift, 4.7 + foot.lift * 0.16, 6.2 - foot.lift * 0.12, aimAngle, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1;
            ctx.stroke();
        };
        drawLeg(leftFoot, 1);
        drawLeg(rightFoot, -1);

        // Torso / body simulator
        ctx.save();
        ctx.translate(torsoX, torsoY + Math.sin(bodyState.breath) * 0.5);
        ctx.rotate(bodyState.torsoRoll);
        ctx.fillStyle = isSelf ? '#3b82f6' : '#ef4444';
        ctx.beginPath();
        ctx.ellipse(0, 0, 11.5, 13.2 - moveAmount * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        if (p.equip_armor) {
            const armorGlow = p.equip_armor.includes('dragon') ? 'rgba(220,38,38,0.5)' :
                p.equip_armor.includes('plate') ? 'rgba(139,92,246,0.6)' :
                p.equip_armor.includes('chain') ? 'rgba(168,162,158,0.5)' :
                'rgba(139,92,246,0.3)';
            ctx.strokeStyle = armorGlow;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(0, 0, 14.5, 15.5, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Arms
        const armSwing = Math.sin(bodyState.stridePhase + (heldEmoji ? Math.PI * 0.35 : 0)) * (3 + moveAmount * 3.5);
        const leftHandX = -rightX * 5 + forwardX * (1 + armSwing);
        const leftHandY = -rightY * 5 + forwardY * (1 + armSwing);
        const rightHandX = rightX * 6 + forwardX * (4 - armSwing);
        const rightHandY = rightY * 6 + forwardY * (4 - armSwing);
        ctx.strokeStyle = 'rgba(10,10,18,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-rightX * 5, -rightY * 5 - 2);
        ctx.lineTo(leftHandX, leftHandY - 1);
        ctx.moveTo(rightX * 5, rightY * 5 - 2);
        ctx.lineTo(rightHandX, rightHandY - 1);
        ctx.stroke();

        // Head
        ctx.fillStyle = '#f8d2b4';
        ctx.beginPath();
        ctx.arc(forwardX * 1.2, -11 - bodyState.headBob * 0.25, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (heldEmoji) {
            ctx.font = '14px serif';
            ctx.textAlign = 'center';
            ctx.fillText(heldEmoji, rightHandX + forwardX * 2, rightHandY + forwardY * 2 - 2);
        }
        ctx.restore();

        // Close squash-stretch transform
        if (squashAmt > 0.01) ctx.restore();
    }

    // Hat above head
    if (p.equip_hat) {
        const hatEmoji = p.equip_hat.includes('void') ? '🕳️' :
                         p.equip_hat.includes('halo') ? '😇' :
                         p.equip_hat.includes('crown') ? '👑' :
                         p.equip_hat.includes('wizard') ? '🧙' :
                         p.equip_hat.includes('cowboy') ? '🤠' : '🧢';
        ctx.font = '12px serif';
        ctx.textAlign = 'center';
        ctx.fillText(hatEmoji, drawX, drawY - 17);
    }

    // Name
    const name = p.display_name || p.username || '???';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(name, drawX + 1, drawY - (p.equip_hat ? 25 : 19));
    ctx.fillStyle = '#fff';
    ctx.fillText(name, drawX, drawY - (p.equip_hat ? 26 : 20));

    // HP bar
    const hp = p.hp ?? 100;
    const maxHp = p.max_hp ?? 100;
    if (hp < maxHp) {
        const bw = 30;
        const pct = hp / maxHp;
        ctx.fillStyle = '#333';
        ctx.fillRect(drawX - bw / 2, drawY - 16, bw, 4);
        ctx.fillStyle = pct > 0.5 ? '#4ade80' : pct > 0.25 ? '#fbbf24' : '#ef4444';
        ctx.fillRect(drawX - bw / 2, drawY - 16, bw * pct, 4);
    }
}

// ── Mob drawing ──────────────────────────────────────────────
function drawMob(ctx, mob, mx, my) {
    const isAggro = mob.state === 'chase';

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(mx, my + 12, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body circle (colored by aggro state)
    ctx.fillStyle = isAggro ? '#dc2626' : '#f59e0b';
    ctx.beginPath();
    ctx.arc(mx, my, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isAggro ? '#fca5a5' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Emoji
    ctx.font = '16px serif';
    ctx.textAlign = 'center';
    ctx.fillText(mob.emoji || '👾', mx, my + 5);

    // Name
    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = isAggro ? '#fca5a5' : '#fbbf24';
    ctx.fillText(mob.name || 'Mob', mx, my - 18);

    // HP bar
    if (mob.hp < mob.maxHp) {
        const bw = 28;
        const pct = mob.hp / mob.maxHp;
        ctx.fillStyle = '#333';
        ctx.fillRect(mx - bw / 2, my - 14, bw, 3);
        ctx.fillStyle = pct > 0.5 ? '#4ade80' : pct > 0.25 ? '#fbbf24' : '#ef4444';
        ctx.fillRect(mx - bw / 2, my - 14, bw * pct, 3);
    }

    // Aggro indicator
    if (isAggro) {
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('!', mx, my - 25);
    }
}

// ── Day/Night cycle overlay ──────────────────────────────────
function drawDayNight(ctx) {
    // dayTime: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
    // Calculate darkness alpha: 0 at noon, 0.55 at midnight
    let darkness;
    if (dayTime < 0.25) {
        // midnight → sunrise: darkest → light
        darkness = 0.55 * (1 - dayTime / 0.25);
    } else if (dayTime < 0.5) {
        // sunrise → noon: fully light
        darkness = 0;
    } else if (dayTime < 0.75) {
        // noon → sunset: fully light → darkening
        darkness = 0;
    } else {
        // sunset → midnight: light → darkest
        darkness = 0.55 * ((dayTime - 0.75) / 0.25);
    }

    if (darkness > 0.02) {
        ctx.fillStyle = `rgba(5, 5, 30, ${darkness})`;
        ctx.fillRect(0, 0, CAM_W, CAM_H);

        // Stars at night
        if (darkness > 0.25) {
            const starAlpha = Math.min(1, (darkness - 0.25) * 2);
            const starSeed = Math.floor(dayTime * 100);
            for (let i = 0; i < 60; i++) {
                // Use large primes to avoid hash clustering with small sequential inputs
                const sx = hashNoise(i * 7919, starSeed * 104729, 12345) * CAM_W;
                const sy = hashNoise(starSeed * 7919, i * 104729, 54321) * (CAM_H * 0.6);
                const twinkle = 0.5 + 0.5 * Math.sin((Date.now() * 0.001) + i * 2.39);
                const size = 1 + hashNoise(i * 3571, i * 6547, 99999) * 1.5;
                ctx.fillStyle = `rgba(255,255,255,${starAlpha * (0.4 + 0.6 * twinkle)})`;
                ctx.fillRect(Math.floor(sx), Math.floor(sy), size, size);
            }
        }
    }
}

// ── Floating text effects ────────────────────────────────────
let floatingTexts = [];
function addFloatingText(x, y, text, color = '#fff') {
    floatingTexts.push({ x, y, text, color, alpha: 1, vy: -1.5, life: 60 });
}
function drawEffects(ctx) {
    floatingTexts = floatingTexts.filter(f => {
        f.y += f.vy;
        f.life--;
        f.alpha = f.life / 60;
        if (f.life <= 0) return false;
        const sx = f.x - camX, sy = f.y - camY;
        ctx.globalAlpha = f.alpha;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, sx, sy);
        ctx.globalAlpha = 1;
        return true;
    });
    // Draw gather/mining particles (world-space)
    for (const gp of gatherParticles) {
        const alpha = (gp.life / gp.maxLife);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = gp.color;
        ctx.beginPath();
        ctx.arc(gp.x - camX, gp.y - camY, gp.size * alpha, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ── Weather Overlay ──────────────────────────────────────────
function drawWeather(ctx) {
    const w = currentWeather.type;
    if (w === 'clear') { weatherParticles.length = 0; return; }

    // Spawn new particles
    const spawnRate = w === 'storm' ? 8 : w === 'rain' ? 4 : w === 'snow' ? 3 : 0;
    for (let i = 0; i < spawnRate && weatherParticles.length < MAX_WEATHER_PARTICLES; i++) {
        if (w === 'rain' || w === 'storm') {
            weatherParticles.push({
                x: Math.random() * CAM_W, y: -10,
                dx: (Math.random() - 0.5) * 2 + (w === 'storm' ? 3 : 0),
                dy: 8 + Math.random() * 4 + (w === 'storm' ? 4 : 0),
                life: 80 + Math.random() * 40,
            });
        } else if (w === 'snow') {
            weatherParticles.push({
                x: Math.random() * CAM_W, y: -10,
                dx: (Math.random() - 0.5) * 1.5,
                dy: 1 + Math.random() * 2,
                life: 200 + Math.random() * 100,
            });
        }
    }

    ctx.save();
    // Rain/storm streaks
    if (w === 'rain' || w === 'storm') {
        ctx.strokeStyle = w === 'storm' ? 'rgba(180,200,255,0.5)' : 'rgba(150,180,220,0.35)';
        ctx.lineWidth = 1;
        weatherParticles = weatherParticles.filter(p => {
            p.x += p.dx; p.y += p.dy; p.life--;
            if (p.life <= 0 || p.y > CAM_H + 10) return false;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.dx * 0.5, p.y - p.dy * 0.5);
            ctx.stroke();
            return true;
        });
        // Storm lightning flash
        if (w === 'storm' && Math.random() < 0.003) {
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fillRect(0, 0, CAM_W, CAM_H);
        }
    }
    // Snow flakes
    else if (w === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        weatherParticles = weatherParticles.filter(p => {
            p.x += p.dx + Math.sin(p.y * 0.02) * 0.5; p.y += p.dy; p.life--;
            if (p.life <= 0 || p.y > CAM_H + 10) return false;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.5 + Math.sin(p.life * 0.1) * 0.5, 0, Math.PI * 2);
            ctx.fill();
            return true;
        });
    }
    // Fog overlay
    if (w === 'fog') {
        ctx.fillStyle = 'rgba(180,180,190,0.25)';
        ctx.fillRect(0, 0, CAM_W, CAM_H);
        // Drifting fog wisps
        const t = Date.now() / 3000;
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = '#ccc';
        for (let i = 0; i < 6; i++) {
            const fx = (Math.sin(t + i * 1.7) * 0.5 + 0.5) * CAM_W;
            const fy = (Math.cos(t * 0.7 + i * 2.3) * 0.5 + 0.5) * CAM_H;
            ctx.beginPath();
            ctx.ellipse(fx, fy, 120 + i * 30, 40 + i * 10, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
    // Storm ambient tint
    if (w === 'storm') {
        ctx.fillStyle = 'rgba(20,20,40,0.12)';
        ctx.fillRect(0, 0, CAM_W, CAM_H);
    }
    ctx.restore();
}

// ── Achievement Toasts ───────────────────────────────────────
function drawAchievementToasts(ctx) {
    if (!achievementToasts.length) return;
    ctx.save();
    let ty = 60;
    achievementToasts = achievementToasts.filter(t => {
        t.timer--;
        if (t.timer <= 0) return false;
        const alpha = t.timer < 30 ? t.timer / 30 : t.timer > 210 ? (240 - t.timer) / 30 : 1;
        ctx.globalAlpha = alpha;
        // Toast background
        const tw = 260, th = 40;
        const tx = CAM_W / 2 - tw / 2;
        ctx.fillStyle = 'rgba(20,15,30,0.9)';
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.strokeRect(tx, ty, tw, th);
        // Trophy icon
        ctx.font = '18px serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#fff';
        ctx.fillText(t.emoji || '🏆', tx + 8, ty + 26);
        // Text
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('Achievement Unlocked!', tx + 32, ty + 16);
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(t.text, tx + 32, ty + 32);
        ctx.globalAlpha = 1;
        ty += th + 4;
        return true;
    });
    ctx.restore();
}

// ── HUD ──────────────────────────────────────────────────────
function drawHUD(ctx) {
    if (!myPlayer) return;
    const p = myPlayer;

    // Font Awesome icon helper for canvas (uses solid style weight 900)
    const faIcon = (size) => `900 ${size}px "Font Awesome 6 Free"`;

    // Top-left: HP/Stamina bars
    const bx = 10, by = 10, bw = 180, bh = 16;
    // HP
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(bx, by, bw * Math.max(0, (p.hp || 0) / (p.max_hp || 100)), bh);
    ctx.fillStyle = '#fff';
    ctx.font = faIcon(10);
    ctx.textAlign = 'left';
    ctx.fillText('\uf004', bx + 4, by + 12); // FA heart
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${p.hp || 0}/${p.max_hp || 100}`, bx + 18, by + 12);
    // Stamina
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by + bh + 3, bw, bh);
    const staRatio = Math.max(0, (p.stamina || 0) / (p.max_stamina || 100));
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(bx, by + bh + 3, bw * staRatio, bh);
    // Regen glow when not full
    if (staRatio < 1) {
        const pulse = 0.15 + 0.1 * Math.sin(Date.now() / 400);
        ctx.fillStyle = `rgba(96, 165, 250, ${pulse})`;
        ctx.fillRect(bx + bw * staRatio, by + bh + 3, Math.min(6, bw * (1 - staRatio)), bh);
    }
    ctx.fillStyle = '#fff';
    ctx.font = faIcon(10);
    ctx.fillText('\uf0e7', bx + 4, by + bh + 14); // FA bolt
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${p.stamina || 0}/${p.max_stamina || 100}`, bx + 18, by + bh + 15);

    // Gold
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by + (bh + 3) * 2, 120, bh);
    ctx.fillStyle = '#fbbf24';
    ctx.font = faIcon(10);
    ctx.fillText('\uf51e', bx + 4, by + (bh + 3) * 2 + 12); // FA coins
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${p.openvibe_coins || 0}`, bx + 20, by + (bh + 3) * 2 + 12);

    // --- Dynamic Y cursor to prevent HUD element overlap ---
    let hudY = by + (bh + 3) * 3;

    // Equipment quickview
    const eqItems = [];
    if (p.equip_weapon) eqItems.push('\uf71d'); // FA sword (crossed-swords)
    if (p.equip_armor) eqItems.push('\uf3ed'); // FA shield
    if (p.equip_hat) eqItems.push('\uf6ae'); // FA hat-wizard
    if (eqItems.length) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx, hudY, 16 * eqItems.length + 8, bh);
        ctx.font = faIcon(11);
        ctx.fillStyle = '#e2e8f0';
        eqItems.forEach((e, i) => ctx.fillText(e, bx + 4 + i * 16, hudY + 13));
        hudY += bh + 3;
    }

    // Current tile info
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    const biome = getBiomeAt(tx, ty, worldSeed);
    const biomeName = biome === 'outpost' ? 'Town' : biome.charAt(0).toUpperCase() + biome.slice(1);
    const tier = getDifficultyTier(tx, ty);
    const tierNames = ['Safe', 'Moderate', 'Dangerous', 'Brutal'];
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, hudY, 160, bh);
    ctx.fillStyle = tier === 0 ? '#4ade80' : tier === 1 ? '#fbbf24' : tier === 2 ? '#f97316' : '#ef4444';
    ctx.font = faIcon(10);
    ctx.fillText('\uf3c5', bx + 4, hudY + 12); // FA map-marker-alt
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${biomeName} (${tierNames[tier]})`, bx + 20, hudY + 12);
    hudY += bh + 6;

    const trackedQuests = myDailyQuests.filter(q => !q.claimed).sort((a, b) => Number(b.completed) - Number(a.completed)).slice(0, 2);
    if (trackedQuests.length) {
        const trackerH = 18 + trackedQuests.length * 20;
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(bx, hudY, 210, trackerH);
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`📜 Daily Quests [G]`, bx + 6, hudY + 12);
        trackedQuests.forEach((quest, index) => {
            const qy = hudY + 18 + index * 20;
            const pct = Math.max(0, Math.min(1, (quest.progress || 0) / Math.max(1, quest.target || 1)));
            ctx.fillStyle = quest.completed ? '#86efac' : '#e5e7eb';
            ctx.font = '10px sans-serif';
            ctx.fillText(`${quest.emoji || '•'} ${quest.name}`, bx + 6, qy + 8);
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(bx + 6, qy + 11, 150, 5);
            ctx.fillStyle = quest.completed ? '#22c55e' : '#3b82f6';
            ctx.fillRect(bx + 6, qy + 11, 150 * pct, 5);
            ctx.fillStyle = quest.completed ? '#86efac' : '#cbd5e1';
            ctx.textAlign = 'right';
            ctx.fillText(`${Math.min(quest.progress || 0, quest.target || 0)}/${quest.target}`, bx + 200, qy + 14);
            ctx.textAlign = 'left';
        });
        hudY += trackerH + 6;
    }

    // Build mode indicator
    if (buildMode) {
        ctx.fillStyle = 'rgba(0,180,0,0.7)';
        ctx.fillRect(CAM_W / 2 - 80, 10, 160, 28);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`🔨 BUILD: ${selectedStructure || 'select'}`, CAM_W / 2, 29);
    }

    // Hotbar hints
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, CAM_H - 24, CAM_W, 24);
    ctx.fillStyle = '#ccc';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    const hints = chatOpen
        ? 'Type message... [Enter] Send  [Esc] Cancel'
        : '[Click] Gather/Attack  [E] Pickup/Fish  [B] Build  [C] Craft  [G] Quests  [I] Inv  [K] Skills  [J] Achieve  [M] Map  [Space] Jump  [Q] Dodge';
    ctx.fillText(hints, CAM_W / 2, CAM_H - 8);

    // Attack cooldown indicator (right of HUD bars)
    const atkElapsed = Date.now() - lastAttackTime;
    if (atkElapsed < attackCooldown) {
        const pct = atkElapsed / attackCooldown;
        const atkCx = bx + bw + 24, atkCy = by + 18;
        ctx.beginPath();
        ctx.arc(atkCx, atkCy, 16, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
        ctx.strokeStyle = pct < 0.5 ? '#ef4444' : '#4ade80';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.font = '900 12px "Font Awesome 6 Free"';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText('\uf71d', atkCx, atkCy + 5); // FA crossed-swords
    }

    // Sprint indicator
    if (isSprinting && (keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD'])) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.font = '900 10px "Font Awesome 6 Free"';
        ctx.textAlign = 'left';
        ctx.fillText('\uf70c', bx, hudY + 2); // FA running
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('SPRINT', bx + 16, hudY + 2);
        hudY += 16;
    }

    // Dodge cooldown indicator
    const dodgeCdLeft = dodgeCooldownUntil - Date.now();
    if (dodgeCdLeft > 0) {
        ctx.fillStyle = 'rgba(96,165,250,0.5)';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`💨 Dodge ${(dodgeCdLeft / 1000).toFixed(1)}s`, bx, hudY + 2);
        hudY += 16;
    }

    // Combo counter
    if (comboCount > 1 && comboTimer > 0) {
        const pulse = 1 + Math.sin(Date.now() / 100) * 0.1;
        const fontSize = Math.min(28, 16 + comboCount * 2);
        ctx.save();
        ctx.font = `bold ${Math.round(fontSize * pulse)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = comboCount >= 5 ? '#ef4444' : comboCount >= 3 ? '#f59e0b' : '#fbbf24';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const comboY = CAM_H / 2 - 80;
        ctx.strokeText(`x${comboCount} COMBO!`, CAM_W / 2, comboY);
        ctx.fillText(`x${comboCount} COMBO!`, CAM_W / 2, comboY);
        ctx.restore();
    }

    // Food buff indicator
    if (activeFoodBuff && Date.now() < activeFoodBuff.expiresAt) {
        const remaining = Math.ceil((activeFoodBuff.expiresAt - Date.now()) / 1000);
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx, hudY, 160, bh);
        ctx.fillStyle = '#4ade80';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`🍽️ ${activeFoodBuff.name} ${min}:${sec.toString().padStart(2,'0')}`, bx + 4, hudY + 12);
        hudY += bh + 3;
    }

    // Day/night time indicator (top-center)
    const timeIcons = ['🌙', '🌅', '☀️', '🌇'];
    const timeNames = ['Night', 'Dawn', 'Day', 'Dusk'];
    const timeIdx = Math.floor(dayTime * 4) % 4;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(CAM_W / 2 - 40, 2, 80, 16);
    ctx.fillStyle = '#ddd';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${timeIcons[timeIdx]} ${timeNames[timeIdx]}`, CAM_W / 2, 14);

    // Weather indicator (next to day/night)
    if (currentWeather.type !== 'clear') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(CAM_W / 2 + 45, 2, 75, 16);
        ctx.fillStyle = '#b0c4de';
        ctx.font = '10px sans-serif';
        const wNames = { rain: '🌧️ Rain', storm: '⛈️ Storm', fog: '🌫️ Fog', snow: '❄️ Snow' };
        ctx.fillText(wNames[currentWeather.type] || currentWeather.type, CAM_W / 2 + 82, 14);
    }

    // Network / multiplayer stats
    const netX = CAM_W - 150;
    const netY = 136;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(netX, netY, 140, 48);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(netX, netY, 140, 48);
    const pingColor = networkStats.rtt <= 90 ? '#4ade80' : networkStats.rtt <= 170 ? '#fbbf24' : '#ef4444';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e5e7eb';
    ctx.fillText(`🌐 ${networkStats.nearbyPlayers || 0} nearby`, netX + 8, netY + 13);
    ctx.fillStyle = pingColor;
    ctx.fillText(`Ping ${Math.round(networkStats.rtt || 0)}ms`, netX + 8, netY + 27);
    ctx.fillStyle = '#93c5fd';
    ctx.fillText(`Tick ${Math.round(networkStats.stateRate || 0)}/s`, netX + 74, netY + 27);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`Jitter ${Math.round(networkStats.jitter || 0)}ms`, netX + 8, netY + 41);
    if (networkStats.packetSkips > 0) {
        ctx.fillStyle = '#fca5a5';
        ctx.textAlign = 'right';
        ctx.fillText(`Miss ${networkStats.packetSkips}`, netX + 132, netY + 41);
    }
}

// ── Minimap ──────────────────────────────────────────────────
function drawMinimap(ctx) {
    if (!minimapReady || !minimapCanvas) return;
    const mw = 120, mh = 120;
    const mx = CAM_W - mw - 10, my = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(mx - 2, my - 2, mw + 4, mh + 4);
    ctx.drawImage(minimapCanvas, 0, 0, MAP_W, MAP_H, mx, my, mw, mh);

    // Fog of war overlay — completely black unexplored areas
    if (fogDirty || !fogCanvas) {
        fogCanvas = document.createElement('canvas');
        fogCanvas.width = MAP_W;
        fogCanvas.height = MAP_H;
        const fctx = fogCanvas.getContext('2d');
        fctx.fillStyle = '#000';
        fctx.fillRect(0, 0, MAP_W, MAP_H);
        // Punch out explored tiles
        fctx.clearRect(0, 0, 0, 0); // no-op, just to set composite
        fctx.globalCompositeOperation = 'destination-out';
        fctx.fillStyle = 'rgba(0,0,0,1)';
        for (const key of exploredTiles) {
            const [ex, ey] = key.split(',');
            fctx.fillRect(+ex, +ey, 1, 1);
        }
        fctx.globalCompositeOperation = 'source-over';
        fogDirty = false;
    }
    ctx.drawImage(fogCanvas, 0, 0, MAP_W, MAP_H, mx, my, mw, mh);

    // Structures as dots
    for (const s of structures) {
        const sx = mx + (s.tile_x / MAP_W) * mw;
        const sy = my + (s.tile_y / MAP_H) * mh;
        ctx.fillStyle = s.owner_id === myUserId ? '#4ade80' : '#ef4444';
        ctx.fillRect(sx, sy, 2, 2);
    }

    // Other players as red dots
    for (const [uid, p] of Object.entries(players)) {
        if (String(uid) === String(myUserId)) continue;
        const sx = mx + ((p.x / TILE) / MAP_W) * mw;
        const sy = my + ((p.y / TILE) / MAP_H) * mh;
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(sx - 1, sy - 1, 3, 3);
    }

    // Self as white dot
    if (myPlayer) {
        const sx = mx + ((myPlayer.x / TILE) / MAP_W) * mw;
        const sy = my + ((myPlayer.y / TILE) / MAP_H) * mh;
        ctx.fillStyle = '#fff';
        ctx.fillRect(sx - 2, sy - 2, 4, 4);
    }

    // NPCs as gold dots — only show explored ones
    for (const npc of NPCS) {
        if (!exploredTiles.has(`${npc.tileX},${npc.tileY}`)) continue;
        const sx = mx + (npc.tileX / MAP_W) * mw;
        const sy = my + (npc.tileY / MAP_H) * mh;
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(sx - 1, sy - 1, 3, 3);
    }

    // Village markers on minimap
    for (const v of VILLAGES) {
        if (!exploredTiles.has(`${v.cx},${v.cy}`)) continue;
        const sx = mx + (v.cx / MAP_W) * mw;
        const sy = my + (v.cy / MAP_H) * mh;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 3, sy - 3, 6, 6);
    }
}

// ── Chat ─────────────────────────────────────────────────────
function addChatMsg(text) {
    chatMessages.push({ text, time: Date.now() });
    if (chatMessages.length > 50) chatMessages.shift();
}

function drawChat(ctx) {
    const chatBottom = CAM_H - 40 - 30 - 45; // above hotbar + its label
    const cx = 10, cy = chatBottom;
    const visible = chatMessages.filter(m => chatOpen || Date.now() - m.time < 8000).slice(-8);
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    for (let i = 0; i < visible.length; i++) {
        const y = cy - (visible.length - 1 - i) * 16;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(cx, y - 12, 350, 16);
        ctx.fillStyle = '#eee';
        ctx.fillText(visible[i].text.slice(0, 60), cx + 4, y);
    }
    if (chatOpen) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(cx, cy + 4, 350, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText('> ' + chatInput + '█', cx + 4, cy + 18);
    }
}

// ── Death screen ─────────────────────────────────────────────
function drawDeathScreen(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, CAM_W, CAM_H);
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOU DIED', CAM_W / 2, CAM_H / 2 - 60);
    ctx.fillStyle = '#ccc';
    ctx.font = '16px sans-serif';
    if (deathDropped.length) {
        ctx.fillText('Lost items:', CAM_W / 2, CAM_H / 2 - 20);
        deathDropped.slice(0, 5).forEach((d, i) => {
            ctx.fillText(`${d.emoji || ''} ${d.name} x${d.qty}`, CAM_W / 2, CAM_H / 2 + 5 + i * 20);
        });
    }
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('Click anywhere to respawn', CAM_W / 2, CAM_H / 2 + 120);
}

// ══════════════════════════════════════════════════════════════
//  PANELS (Inventory, Bank, Shop, Crafting, Skills, Map, etc.)
// ══════════════════════════════════════════════════════════════

function togglePanel(name) {
    if (activePanel === name) {
        // Close current panel with animation
        panelAnimDir = -1;
        panelClosingTo = null;
        activeNPC = null; npcShopData = null; invGridHeldItem = null;
        return;
    }
    if (activePanel && activePanel !== name) {
        // Switch panel: close current, then open new
        panelAnimDir = -1;
        panelClosingTo = name;
        invGridHeldItem = null;
        return;
    }
    // Open new panel
    activePanel = name;
    invGridHeldItem = null;
    panelAnimProgress = 0;
    panelAnimDir = 1;
    loadPanelData(name);
}

function updatePanelAnimation() {
    if (panelAnimDir === 0) return;
    panelAnimProgress += panelAnimDir * panelAnimSpeed;
    if (panelAnimProgress >= 1) {
        panelAnimProgress = 1;
        panelAnimDir = 0;
    } else if (panelAnimProgress <= 0) {
        panelAnimProgress = 0;
        panelAnimDir = 0;
        activePanel = null;
        if (panelClosingTo) {
            // Open the queued panel
            activePanel = panelClosingTo;
            panelClosingTo = null;
            panelAnimProgress = 0;
            panelAnimDir = 1;
            invGridHeldItem = null;
            loadPanelData(activePanel);
        }
    }
}

function interactWithNPC(npc) {
    if (!npc) { addChatMsg('❓ No NPC nearby'); return; }
    activeNPC = npc.id;
    npcShopData = null;
    npcShopTab = 'buy';
    npcShopScroll = 0;
    if (npc.id === 'banker') {
        activePanel = 'bank';
    } else {
        activePanel = 'npc_shop';
    }
    panelAnimProgress = 0;
    panelAnimDir = 1;
    }
    loadNPCData(npc.id);
}

async function loadNPCData(npcId) {
    try {
        const res = await api('/game/npc/interact', { method: 'POST', body: JSON.stringify({ npcId }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); activePanel = null; return; }
        npcShopData = res;
        if (res.type === 'bank') {
            panelData.bank = res.bank;
            panelData.inventory = res.inventory;
        }
    } catch (e) { addChatMsg('❌ Failed to connect to NPC'); activePanel = null; }
}

async function loadPanelData(name) {
    try {
        if (name === 'inventory') { panelData.inventory = (await api('/game/inventory')).items; refreshHotbarFromInventory(); }
        else if (name === 'bank') {
            panelData.bank = (await api('/game/bank')).items;
            panelData.inventory = (await api('/game/inventory')).items;
        }
        else if (name === 'crafting') {
            const [recipeData, invData] = await Promise.all([api('/game/recipes'), api('/game/inventory')]);
            panelData.recipes = recipeData.recipes;
            craftInventory = {};
            (invData.items || []).forEach(i => { craftInventory[i.item_id] = i.quantity; });
            craftCategory = 'all';
            craftScroll = 0;
        }
        else if (name === 'skills') {
            const pData = (await api('/game/player')).player;
            // Also refresh myPlayer equip data
            if (pData && myPlayer) {
                myPlayer.equip_weapon = pData.equip_weapon;
                myPlayer.equip_armor = pData.equip_armor;
                myPlayer.equip_hat = pData.equip_hat;
                myPlayer.equip_pickaxe = pData.equip_pickaxe;
                myPlayer.equip_axe = pData.equip_axe;
                myPlayer.equip_rod = pData.equip_rod;
                myPlayer.attack = pData.attack;
                myPlayer.defense = pData.defense;
            }
            panelData.player = pData;
        }
        else if (name === 'leaderboard') panelData.leaderboard = (await api('/game/leaderboard/total_level')).entries;
        else if (name === 'fish_album') {
            const data = await api('/game/fish-collection');
            panelData.fishCollection = data;
        }
        else if (name === 'achievements') {
            const data = await api('/game/achievements');
            myAchievements = data.achievements || [];
        }
        else if (name === 'quests') {
            await refreshDailyQuests(true);
        }
        else if (name === 'build') {} // Build menu uses static data
    } catch (e) { addChatMsg('❌ Failed to load panel data'); }
}

function applyDailyQuestData(data, { notify = false } = {}) {
    if (!data) return;
    myDailyQuests = Array.isArray(data.quests) ? data.quests : [];
    dailyQuestMeta = {
        claimed: data.claimed || 0,
        total: data.total || myDailyQuests.length,
        completed: data.completed || 0,
        streak: data.streak || 0,
        nextResetAt: data.nextResetAt || null,
        date: data.date || '',
    };
    panelData.quests = myDailyQuests;

    for (const quest of myDailyQuests) {
        if (quest.completed && !quest.claimed) {
            if (notify && !dailyQuestReadyNotified.has(quest.id)) {
                addChatMsg(`📜 Daily quest ready: ${quest.emoji || '✅'} ${quest.name}`);
            }
            dailyQuestReadyNotified.add(quest.id);
        }
        if (quest.claimed) dailyQuestReadyNotified.add(quest.id);
    }
}

async function refreshDailyQuests(force = false) {
    const now = Date.now();
    if (!force && (now - dailyQuestLastSync) < 5000) return;
    dailyQuestLastSync = now;
    try {
        const data = await api('/game/daily-quests');
        if (data?.success) applyDailyQuestData(data, { notify: true });
    } catch (_) {}
}

async function claimDailyQuest(questId) {
    try {
        const res = await api('/game/daily-quests/claim', { method: 'POST', body: JSON.stringify({ questId }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        if (res.success) {
            const rewardBits = [];
            if (res.reward?.coins) rewardBits.push(`🪙 ${res.reward.coins}`);
            if (res.reward?.item) {
                const qty = res.reward.qty || 1;
                rewardBits.push(`${qty}x ${res.reward.item}`);
            }
            addChatMsg(`✅ Daily quest claimed: ${res.quest?.emoji || '📜'} ${res.quest?.name}${rewardBits.length ? ` — ${rewardBits.join(', ')}` : ''}`);
            if (res.daily) applyDailyQuestData(res.daily);
            refreshCoins();
            if (activePanel === 'inventory') loadPanelData('inventory');
        }
    } catch {
        addChatMsg('❌ Failed to claim daily quest');
    }
}

function drawPanel(ctx) {
    const pw = 340, ph = 420;
    // Eased slide-in from right
    const eased = 1 - Math.pow(1 - panelAnimProgress, 3); // easeOutCubic
    const slideOffset = (1 - eased) * (pw + 20);
    const px = CAM_W - pw - 15 + slideOffset, py = 130;

    ctx.save();
    ctx.globalAlpha = eased;

    // Rounded rectangle helper
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(px + r, py);
    ctx.lineTo(px + pw - r, py);
    ctx.arcTo(px + pw, py, px + pw, py + r, r);
    ctx.lineTo(px + pw, py + ph - r);
    ctx.arcTo(px + pw, py + ph, px + pw - r, py + ph, r);
    ctx.lineTo(px + r, py + ph);
    ctx.arcTo(px, py + ph, px, py + ph - r, r);
    ctx.lineTo(px, py + r);
    ctx.arcTo(px, py, px + r, py, r);
    ctx.closePath();

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = -4;
    ctx.shadowOffsetY = 4;

    // Background with theme
    ctx.fillStyle = theme.bgPanel ? theme.bgPanel + 'ee' : 'rgba(15,15,25,0.95)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.strokeStyle = theme.border || '#555';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Clip to rounded rect for content
    ctx.clip();

    // Accent top bar
    ctx.fillStyle = theme.accent || '#8b5cf6';
    ctx.fillRect(px, py, pw, 3);
    // Title
    ctx.fillStyle = theme.text || '#fff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    const faTitles = {
        inventory: { icon: '\uf187', label: 'Inventory' },     // fa-archive/box
        bank:      { icon: '\uf19c', label: 'Bank' },          // fa-university
        shop:      { icon: '\uf07a', label: 'Shop' },          // fa-shopping-cart
        crafting:  { icon: '\uf6e3', label: 'Crafting' },      // fa-hammer
        skills:    { icon: '\uf201', label: 'Skills' },        // fa-chart-line
        quests:    { icon: '\uf0ae', label: 'Daily Quests' },  // fa-tasks/list-check-ish
        map:       { icon: '\uf279', label: 'World Map' },     // fa-map
        leaderboard:{ icon: '\uf091', label: 'Leaderboard' },  // fa-trophy
        build:     { icon: '\uf1b3', label: 'Build Menu' },    // fa-cubes
        fish_album:{ icon: '\uf578', label: 'Fish Album' },    // fa-fish
        npc_shop:  { icon: '\uf07a', label: activeNPC ? ((NPCS.find(n => n.id === activeNPC) || {}).name || 'Shop') : 'Shop' },
        achievements: { icon: '\uf091', label: 'Achievements' }, // fa-trophy
    };
    const titleInfo = faTitles[activePanel];
    if (titleInfo) {
        ctx.font = '900 14px "Font Awesome 6 Free"';
        ctx.fillText(titleInfo.icon, px + 10, py + 22);
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(titleInfo.label, px + 28, py + 22);
    } else {
        ctx.fillText(activePanel, px + 10, py + 22);
    }
    ctx.fillStyle = theme.textMuted || '#999';
    ctx.font = '11px sans-serif';
    ctx.fillText('[ESC to close]', px + pw - 90, py + 22);

    // Separator line below title
    ctx.strokeStyle = (theme.border || '#555') + '80';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + 8, py + 32);
    ctx.lineTo(px + pw - 8, py + 32);
    ctx.stroke();

    const contentY = py + 35;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, contentY, pw, ph - 35);
    ctx.clip();

    if (activePanel === 'inventory') drawInventoryPanel(ctx, px, contentY, pw);
    else if (activePanel === 'bank') drawBankPanel(ctx, px, contentY, pw);
    else if (activePanel === 'shop' || activePanel === 'npc_shop') drawNPCShopPanel(ctx, px, contentY, pw);
    else if (activePanel === 'crafting') drawCraftingPanel(ctx, px, contentY, pw);
    else if (activePanel === 'skills') drawSkillsPanel(ctx, px, contentY, pw);
    else if (activePanel === 'quests') drawQuestsPanel(ctx, px, contentY, pw);
    else if (activePanel === 'leaderboard') drawLeaderboardPanel(ctx, px, contentY, pw);
    else if (activePanel === 'build') drawBuildPanel(ctx, px, contentY, pw);
    else if (activePanel === 'map') drawMapPanel(ctx, px, contentY, pw);
    else if (activePanel === 'fish_album') drawFishAlbumPanel(ctx, px, contentY, pw);
    else if (activePanel === 'achievements') drawAchievementsPanel(ctx, px, contentY, pw);

    ctx.restore(); // content clip
    ctx.restore(); // panel alpha + rounded clip
}

function drawItemList(ctx, items, px, py, pw) {
    if (!items || !items.length) {
        ctx.fillStyle = '#888';
        ctx.font = '13px sans-serif';
        ctx.fillText('(empty)', px + 10, py + 20);
        return;
    }
    items.forEach((item, i) => {
        const y = py + i * 22;
        ctx.fillStyle = RARITY_COLORS[item.rarity] || '#aaa';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${item.emoji || '❓'} ${item.name || item.item_id}`, px + 10, y + 16);
        ctx.fillStyle = '#ccc';
        ctx.textAlign = 'right';
        ctx.fillText(`x${item.quantity}`, px + pw - 10, y + 16);
        ctx.textAlign = 'left';
    });
}

// ── Enhanced Tooltip Helpers ──
function drawTooltip(ctx, mx, my, panelX, panelW, panelY, item, fallbackName, actionText) {
    if (!item && !fallbackName) return;
    const name = item?.name || fallbackName || '???';
    const emoji = item?.emoji || '';
    const rarity = item?.rarity || 'Common';
    const category = item?.category || '';
    const quantity = item?.quantity || 1;
    const rarCol = RARITY_COLORS[rarity] || '#aaa';

    const lines = [`${emoji} ${name}`];
    if (item) lines.push(`${rarity}  ×${quantity}  [${category || '?'}]`);
    if (actionText) lines.push(actionText);

    const ttW = 170, lineH = 15;
    const ttH = 10 + lines.length * lineH;
    let ttX = mx + 14, ttY = my - 8;
    if (ttX + ttW > panelX + panelW + 20) ttX = mx - ttW - 8;
    if (ttY + ttH > panelY + 380) ttY = my - ttH;

    // Rounded tooltip background
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(ttX + r, ttY);
    ctx.lineTo(ttX + ttW - r, ttY);
    ctx.arcTo(ttX + ttW, ttY, ttX + ttW, ttY + r, r);
    ctx.lineTo(ttX + ttW, ttY + ttH - r);
    ctx.arcTo(ttX + ttW, ttY + ttH, ttX + ttW - r, ttY + ttH, r);
    ctx.lineTo(ttX + r, ttY + ttH);
    ctx.arcTo(ttX, ttY + ttH, ttX, ttY + ttH - r, r);
    ctx.lineTo(ttX, ttY + r);
    ctx.arcTo(ttX, ttY, ttX + r, ttY, r);
    ctx.closePath();

    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(10,10,18,0.96)';
    ctx.fill();
    ctx.shadowBlur = 0;

    // Rarity accent bar (left edge)
    ctx.fillStyle = rarCol;
    ctx.fillRect(ttX, ttY + 4, 3, ttH - 8);

    // Border
    ctx.strokeStyle = rarCol + '80';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Text
    ctx.textAlign = 'left';
    ctx.fillStyle = rarCol;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(lines[0], ttX + 8, ttY + 14);

    if (lines[1] && item) {
        ctx.fillStyle = theme.textDim || '#aaa';
        ctx.font = '9px sans-serif';
        ctx.fillText(lines[1], ttX + 8, ttY + 14 + lineH);
    }
    if (actionText) {
        ctx.fillStyle = '#fbbf24';
        ctx.font = '9px sans-serif';
        ctx.fillText(actionText, ttX + 8, ttY + 14 + (lines.length - 1) * lineH);
    }
}

function drawTooltipSimple(ctx, mx, my, panelX, panelW, text) {
    const ttW = 120, ttH = 22;
    let ttX = mx + 14, ttY = my - 8;
    if (ttX + ttW > panelX + panelW + 20) ttX = mx - ttW - 8;

    const r = 4;
    ctx.beginPath();
    ctx.moveTo(ttX + r, ttY);
    ctx.lineTo(ttX + ttW - r, ttY);
    ctx.arcTo(ttX + ttW, ttY, ttX + ttW, ttY + r, r);
    ctx.lineTo(ttX + ttW, ttY + ttH - r);
    ctx.arcTo(ttX + ttW, ttY + ttH, ttX + ttW - r, ttY + ttH, r);
    ctx.lineTo(ttX + r, ttY + ttH);
    ctx.arcTo(ttX, ttY + ttH, ttX, ttY + ttH - r, r);
    ctx.lineTo(ttX, ttY + r);
    ctx.arcTo(ttX, ttY, ttX + r, ttY, r);
    ctx.closePath();

    ctx.fillStyle = 'rgba(10,10,18,0.96)';
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(text, ttX + 8, ttY + 14);
}

function drawInventoryPanel(ctx, px, py, pw) {
    const items = panelData.inventory;
    if (!items) { ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '13px sans-serif'; ctx.fillText('Loading...', px + 10, py + 20); return; }

    const SLOT = 40, GAP = 3, COLS = 7, EQUIP_SLOT = 44;

    // Helper: draw a rounded rect slot
    function drawSlotBg(sx, sy, sw, sh, rad) {
        ctx.beginPath();
        ctx.moveTo(sx + rad, sy);
        ctx.lineTo(sx + sw - rad, sy);
        ctx.arcTo(sx + sw, sy, sx + sw, sy + rad, rad);
        ctx.lineTo(sx + sw, sy + sh - rad);
        ctx.arcTo(sx + sw, sy + sh, sx + sw - rad, sy + sh, rad);
        ctx.lineTo(sx + rad, sy + sh);
        ctx.arcTo(sx, sy + sh, sx, sy + sh - rad, rad);
        ctx.lineTo(sx, sy + rad);
        ctx.arcTo(sx, sy, sx + rad, sy, rad);
        ctx.closePath();
    }

    // ── Equipment Slots (left column, 6 slots in 2 cols × 3 rows) ──
    ctx.fillStyle = theme.accent || '#8b5cf6';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('EQUIPMENT', px + 8, py + 12);

    const equipSlots = [
        { label: '⚔️', key: 'equip_weapon', name: 'Weapon', cat: 'weapons' },
        { label: '🛡️', key: 'equip_armor', name: 'Armor', cat: 'armor' },
        { label: '🎩', key: 'equip_hat', name: 'Hat', cat: 'hats' },
        { label: '⛏️', key: 'equip_pickaxe', name: 'Pick', cat: 'pickaxes' },
        { label: '🪓', key: 'equip_axe', name: 'Axe', cat: 'axes' },
        { label: '🎣', key: 'equip_rod', name: 'Rod', cat: 'rods' },
    ];

    const eqX = px + 6, eqStartY = py + 18;
    const EQUIP_CAT_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
    equipSlots.forEach((slot, i) => {
        const row = i % 3, col = Math.floor(i / 3);
        const sx = eqX + col * (EQUIP_SLOT + GAP);
        const sy = eqStartY + row * (EQUIP_SLOT + GAP);
        // Rounded slot background
        drawSlotBg(sx, sy, EQUIP_SLOT, EQUIP_SLOT, 4);
        ctx.fillStyle = theme.bgCard || '#1a1a20';
        ctx.fill();
        const equipped = myPlayer?.[slot.key];

        // Highlight matching slot when dragging an equippable item
        const isDragTarget = invGridHeldItem && EQUIP_CAT_MAP[invGridHeldItem.category] === slot.key;
        if (isDragTarget) {
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2.5;
            ctx.shadowColor = '#4ade80';
            ctx.shadowBlur = 8;
            drawSlotBg(sx, sy, EQUIP_SLOT, EQUIP_SLOT, 4);
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else if (equipped) {
            const invItem = items.find(it => it.item_id === equipped);
            const rarCol = RARITY_COLORS[invItem?.rarity];
            if (rarCol && invItem?.rarity !== 'Common' && invItem?.rarity !== 'Junk') {
                ctx.shadowColor = rarCol;
                ctx.shadowBlur = 6;
            }
            ctx.strokeStyle = rarCol || (theme.accent || '#8b5cf6');
            ctx.lineWidth = 2;
            drawSlotBg(sx, sy, EQUIP_SLOT, EQUIP_SLOT, 4);
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else {
            ctx.strokeStyle = theme.border || '#333';
            ctx.lineWidth = 1;
            drawSlotBg(sx, sy, EQUIP_SLOT, EQUIP_SLOT, 4);
            ctx.stroke();
        }
        ctx.textAlign = 'center';
        if (equipped) {
            const invItem = items.find(it => it.item_id === equipped);
            ctx.font = '20px serif';
            ctx.fillStyle = '#fff';
            ctx.fillText(invItem?.emoji || slot.label, sx + EQUIP_SLOT / 2, sy + 26);
            ctx.font = '7px sans-serif';
            ctx.fillStyle = RARITY_COLORS[invItem?.rarity] || theme.textDim || '#aaa';
            const shortName = (invItem?.name || equipped).replace(/^(Bamboo |Fiberglass |Carbon |Titanium |Mythril |Stone |Iron |Steel |Diamond |Wooden |Bronze )/, '').slice(0, 8);
            ctx.fillText(shortName, sx + EQUIP_SLOT / 2, sy + 39);
        } else {
            ctx.fillStyle = theme.textMuted || '#444';
            ctx.font = '15px serif';
            ctx.fillText(slot.label, sx + EQUIP_SLOT / 2, sy + 24);
            ctx.font = '7px sans-serif';
            ctx.fillText(slot.name, sx + EQUIP_SLOT / 2, sy + 37);
        }
    });

    // ── Sonar button (if player has fish sonar) ──
    const hasSonar = items.some(it => it.item_id === 'fish_sonar');
    if (hasSonar) {
        const btnX = px + 6 + 2 * (EQUIP_SLOT + GAP), btnY = eqStartY + 2 * (EQUIP_SLOT + GAP);
        drawSlotBg(btnX, btnY, EQUIP_SLOT, EQUIP_SLOT, 4);
        ctx.fillStyle = '#1a3a4a';
        ctx.fill();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = '16px serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText('📡', btnX + EQUIP_SLOT / 2, btnY + 24);
        ctx.font = '7px sans-serif';
        ctx.fillStyle = '#3b82f6';
        ctx.fillText('Sonar', btnX + EQUIP_SLOT / 2, btnY + 37);
    }

    // ── Inventory Grid (Minecraft-style) ──
    const gridStartY = eqStartY + 3 * (EQUIP_SLOT + GAP) + 8;

    // ── Coin Display (dedicated bar above backpack, full width) ──
    const coinAmount = myPlayer?.openvibe_coins || 0;
    const coinBarY = gridStartY - 16;
    drawSlotBg(px + 4, coinBarY, pw - 8, 14, 3);
    ctx.fillStyle = 'rgba(255,191,36,0.12)';
    ctx.fill();
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(`🪙 ${coinAmount.toLocaleString()} Gold`, px + pw / 2, coinBarY + 11);

    ctx.fillStyle = theme.accent || '#8b5cf6';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`BACKPACK (${items.length})`, px + 8, gridStartY + 2);

    // Calculate visible rows
    const gridW = COLS * (SLOT + GAP);
    const gridX = px + Math.floor((pw - gridW) / 2);
    const availH = 380 - (gridStartY - py);
    const ROWS = Math.max(1, Math.floor(availH / (SLOT + GAP)));
    const maxScroll = Math.max(0, Math.ceil(items.length / COLS) - ROWS);
    if (invGridScroll > maxScroll) invGridScroll = maxScroll;

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const slotIdx = (row + invGridScroll) * COLS + col;
            const sx = gridX + col * (SLOT + GAP);
            const sy = gridStartY + 8 + row * (SLOT + GAP);

            // Rounded slot background
            drawSlotBg(sx, sy, SLOT, SLOT, 3);
            ctx.fillStyle = theme.bgCard || '#1a1a20';
            ctx.fill();
            ctx.strokeStyle = theme.border || '#333';
            ctx.lineWidth = 1;
            ctx.stroke();

            if (slotIdx < items.length) {
                const item = items[slotIdx];
                if (invGridHeldItem && invGridHeldItem.fromSlot === slotIdx) continue;

                // Rarity glow effect for rare+ items
                const rarCol = RARITY_COLORS[item.rarity];
                if (rarCol && item.rarity !== 'Common' && item.rarity !== 'Junk') {
                    ctx.shadowColor = rarCol;
                    ctx.shadowBlur = item.rarity === 'Legendary' || item.rarity === 'Mythic' ? 8 : 4;
                    drawSlotBg(sx, sy, SLOT, SLOT, 3);
                    ctx.strokeStyle = rarCol;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                }

                // Item emoji
                ctx.font = '20px serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#fff';
                ctx.fillText(item.emoji || '❓', sx + SLOT / 2, sy + 24);

                // Quantity badge (bottom-right, pill-shaped)
                if (item.quantity > 1) {
                    const qText = `${item.quantity}`;
                    ctx.font = 'bold 9px sans-serif';
                    const qW = Math.max(14, ctx.measureText(qText).width + 6);
                    const qX = sx + SLOT - qW - 1, qY = sy + SLOT - 12;
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    drawSlotBg(qX, qY, qW, 11, 3);
                    ctx.fill();
                    ctx.textAlign = 'center';
                    ctx.fillStyle = '#fff';
                    ctx.fillText(qText, qX + qW / 2, qY + 9);
                }
            }
        }
    }

    // Scroll indicator (rounded track)
    const totalRows = Math.ceil(items.length / COLS);
    if (totalRows > ROWS) {
        const trackH = ROWS * (SLOT + GAP);
        const scrollBarH = Math.max(14, (ROWS / totalRows) * trackH);
        const scrollBarY = gridStartY + 8 + (invGridScroll / maxScroll) * (trackH - scrollBarH);
        // Track
        ctx.fillStyle = (theme.border || '#333') + '40';
        drawSlotBg(gridX + gridW + 3, gridStartY + 8, 4, trackH, 2);
        ctx.fill();
        // Thumb
        ctx.fillStyle = theme.accent || '#8b5cf6';
        drawSlotBg(gridX + gridW + 3, scrollBarY, 4, scrollBarH, 2);
        ctx.fill();
    }

    // ── Held item follows cursor ──
    if (invGridHeldItem) {
        ctx.globalAlpha = 0.85;
        ctx.font = '24px serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 6;
        ctx.fillText(invGridHeldItem.emoji || '❓', mouseX, mouseY - 4);
        ctx.shadowBlur = 0;
        if (invGridHeldItem.quantity > 1) {
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillStyle = '#fff';
            ctx.fillText(`${invGridHeldItem.quantity}`, mouseX + 14, mouseY + 10);
        }
        ctx.globalAlpha = 1;
    }

    // ── Tooltip on hover (equipment slots) ──
    for (let ei = 0; ei < equipSlots.length; ei++) {
        const row = ei % 3, col = Math.floor(ei / 3);
        const sx = eqX + col * (EQUIP_SLOT + GAP);
        const sy = eqStartY + row * (EQUIP_SLOT + GAP);
        if (mouseX >= sx && mouseX <= sx + EQUIP_SLOT && mouseY >= sy && mouseY <= sy + EQUIP_SLOT) {
            const equipped = myPlayer?.[equipSlots[ei].key];
            if (equipped) {
                const invItem = items.find(it => it.item_id === equipped);
                drawTooltip(ctx, mouseX, mouseY, px, pw, py, invItem, equipped, 'Click to unequip');
            } else {
                drawTooltipSimple(ctx, mouseX, mouseY, px, pw, `${equipSlots[ei].name} — empty`);
            }
            break;
        }
    }

    // ── Tooltip on hover (backpack grid) ──
    const gridTop = gridStartY + 8;
    if (mouseX >= gridX && mouseX <= gridX + gridW && mouseY >= gridTop && mouseY <= gridTop + ROWS * (SLOT + GAP)) {
        const hCol = Math.floor((mouseX - gridX) / (SLOT + GAP));
        const hRow = Math.floor((mouseY - gridTop) / (SLOT + GAP));
        const hIdx = (hRow + invGridScroll) * COLS + hCol;
        if (hCol >= 0 && hCol < COLS && hIdx >= 0 && hIdx < items.length) {
            const item = items[hIdx];
            const action = (['weapons', 'armor', 'hats', 'pickaxes', 'axes', 'rods'].includes(item.category)) ? 'Drag to equip slot' :
                (item.category === 'consumable' || item.category === 'potion') ? 'Click to use' :
                (item.category === 'name_effects' || item.category === 'particles' || item.category === 'voices') ? 'Click to unlock as global cosmetic' :
                (item.item_id === 'fish_sonar') ? 'Click to ping' : '';
            drawTooltip(ctx, mouseX, mouseY, px, pw, py, item, null, action);
        }
    }

    // ── Sonar overlay (temporary) ──
    if (sonarOverlay && Date.now() < sonarOverlay.expiresAt) {
        const sonarY = py + 2;
        ctx.fillStyle = 'rgba(10,30,50,0.92)';
        ctx.fillRect(px + pw - 145, sonarY, 140, 14 + sonarOverlay.zones.length * 28);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + pw - 145, sonarY, 140, 14 + sonarOverlay.zones.length * 28);
        ctx.fillStyle = '#3b82f6';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('📡 SONAR SCAN', px + pw - 138, sonarY + 10);
        sonarOverlay.zones.forEach((z, zi) => {
            const zy = sonarY + 14 + zi * 28;
            ctx.fillStyle = '#5bc0de';
            ctx.font = 'bold 8px sans-serif';
            ctx.fillText(z.zone.toUpperCase(), px + pw - 138, zy + 9);
            ctx.fillStyle = '#aaa';
            ctx.font = '8px sans-serif';
            z.fish.slice(0, 3).forEach((f, fi) => {
                ctx.fillText(`${f.emoji} ${f.name}`, px + pw - 138, zy + 18 + fi * 9);
            });
        });
    } else if (sonarOverlay) {
        sonarOverlay = null;
    }
}
function drawBankPanel(ctx, px, py, pw) {
    if (!npcShopData || !panelData.bank) {
        ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '13px sans-serif';
        ctx.fillText('Loading...', px + 10, py + 20); return;
    }
    // Tab row: Deposit | Withdraw
    const tabW = (pw - 20) / 2;
    ['deposit', 'withdraw'].forEach((t, i) => {
        const tx = px + 10 + i * tabW;
        const active = npcShopTab === t;
        ctx.fillStyle = active ? (theme.accent || '#8b5cf6') : (theme.bgCard || '#1a1a20');
        ctx.fillRect(tx, py, tabW - 2, 18);
        ctx.fillStyle = active ? '#000' : (theme.textDim || '#aaa');
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t === 'deposit' ? '📥 Deposit' : '📤 Withdraw', tx + tabW / 2, py + 13);
    });
    ctx.textAlign = 'left';

    const items = npcShopTab === 'deposit' ? (panelData.inventory || []) : (panelData.bank || []);
    const startY = py + 24;
    if (!items.length) {
        ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '12px sans-serif';
        ctx.fillText(npcShopTab === 'deposit' ? 'Nothing to deposit' : 'Bank is empty', px + 10, startY + 16);
        return;
    }
    items.slice(npcShopScroll, npcShopScroll + 14).forEach((item, i) => {
        const y = startY + i * 22;
        if (i % 2 === 0) { ctx.fillStyle = (theme.bgCard || '#1a1a20') + '44'; ctx.fillRect(px + 4, y + 2, pw - 8, 20); }
        ctx.fillStyle = RARITY_COLORS[item.rarity] || '#aaa';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${item.emoji || '❓'} ${item.name}`, px + 10, y + 15);
        ctx.fillStyle = theme.textDim || '#ccc';
        ctx.textAlign = 'right';
        ctx.fillText(`×${item.quantity}`, px + pw - 50, y + 15);
        // Action button
        ctx.fillStyle = theme.accent || '#8b5cf6';
        ctx.fillRect(px + pw - 44, y + 2, 38, 16);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(npcShopTab === 'deposit' ? 'DEP' : 'WDR', px + pw - 25, y + 13);
        ctx.textAlign = 'left';
    });
}

function drawNPCShopPanel(ctx, px, py, pw) {
    if (!npcShopData) {
        ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '13px sans-serif';
        ctx.fillText('Loading...', px + 10, py + 20); return;
    }
    // Gold display
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`🪙 ${npcShopData.openvibe_coins || 0}`, px + pw - 10, py + 12);
    ctx.textAlign = 'left';

    // Tab row: Buy | Sell
    const tabW = (pw - 20) / 2;
    ['buy', 'sell'].forEach((t, i) => {
        const tx = px + 10 + i * tabW;
        const active = npcShopTab === t;
        ctx.fillStyle = active ? (theme.accent || '#8b5cf6') : (theme.bgCard || '#1a1a20');
        ctx.fillRect(tx, py + 16, tabW - 2, 18);
        ctx.fillStyle = active ? '#000' : (theme.textDim || '#aaa');
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t === 'buy' ? '🛒 Buy' : '💰 Sell', tx + tabW / 2, py + 29);
    });
    ctx.textAlign = 'left';

    const startY = py + 40;
    if (npcShopTab === 'buy') {
        const items = (npcShopData.items || []).filter(i => i.buyCost !== null);
        if (!items.length) {
            ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '12px sans-serif';
            ctx.fillText('Nothing for sale here', px + 10, startY + 16);
            return;
        }
        items.slice(npcShopScroll, npcShopScroll + 13).forEach((item, i) => {
            const y = startY + i * 24;
            if (i % 2 === 0) { ctx.fillStyle = (theme.bgCard || '#1a1a20') + '44'; ctx.fillRect(px + 4, y, pw - 8, 22); }

            // Check level requirement
            const SKILL_MAP = { pickaxes: 'mining', axes: 'woodcut', rods: 'fishing', weapons: 'combat', armor: 'combat' };
            const skillNeeded = SKILL_MAP[item.category];
            const playerLvl = skillNeeded && npcShopData.playerLevels ? (npcShopData.playerLevels[skillNeeded] || 1) : 999;
            const meetsLevel = !item.levelReq || playerLvl >= item.levelReq;

            const rarCol = RARITY_COLORS[item.rarity] || '#aaa';
            ctx.fillStyle = meetsLevel ? rarCol : '#666';
            ctx.font = '12px sans-serif';
            const nameText = `${item.emoji || '❓'} ${item.name}`;
            ctx.fillText(nameText, px + 10, y + 15);
            // Level requirement tag
            if (item.levelReq && !meetsLevel) {
                ctx.fillStyle = '#ef4444';
                ctx.font = 'bold 8px sans-serif';
                ctx.fillText(`Lv${item.levelReq}`, px + 10 + ctx.measureText(nameText).width + 4, y + 14);
            } else if (item.levelReq) {
                ctx.fillStyle = '#4ade80';
                ctx.font = '8px sans-serif';
                ctx.fillText(`Lv${item.levelReq}`, px + 10 + ctx.measureText(nameText).width + 4, y + 14);
            }
            // Price
            const canAfford = (npcShopData.openvibe_coins || 0) >= item.buyCost;
            const canBuy = canAfford && meetsLevel;
            ctx.fillStyle = canAfford ? '#fbbf24' : '#ef4444';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`🪙${item.buyCost}`, px + pw - 48, y + 15);
            // Buy button
            ctx.fillStyle = canBuy ? (theme.accent || '#8b5cf6') : (theme.textMuted || '#444');
            ctx.fillRect(px + pw - 44, y + 2, 38, 18);
            ctx.fillStyle = canBuy ? '#000' : '#888';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('BUY', px + pw - 25, y + 14);
            ctx.textAlign = 'left';
        });
        if (items.length > 13) {
            ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '10px sans-serif';
            ctx.fillText(`↕ Scroll for more (${items.length} items)`, px + 10, startY + 13 * 24 + 14);
        }
    } else {
        // Sell tab — show player inventory items that this NPC buys
        const inv = npcShopData.inventory || [];
        const sellable = inv.filter(i => {
            const npc = NPCS.find(n => n.id === activeNPC);
            if (!npc) return i.sellPrice;
            return i.sellPrice && npc.categories && npc.categories.includes(i.category);
        });
        if (!sellable.length) {
            ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '12px sans-serif';
            ctx.fillText('No items to sell to this merchant', px + 10, startY + 16);
            return;
        }
        sellable.slice(npcShopScroll, npcShopScroll + 13).forEach((item, i) => {
            const y = startY + i * 24;
            if (i % 2 === 0) { ctx.fillStyle = (theme.bgCard || '#1a1a20') + '44'; ctx.fillRect(px + 4, y, pw - 8, 22); }
            ctx.fillStyle = RARITY_COLORS[item.rarity] || '#aaa';
            ctx.font = '12px sans-serif';
            ctx.fillText(`${item.emoji || '❓'} ${item.name} (×${item.quantity})`, px + 10, y + 15);
            // Sell price
            ctx.fillStyle = '#4fc94f';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`+🪙${item.sellPrice}`, px + pw - 48, y + 15);
            // Sell button
            ctx.fillStyle = theme.accent || '#8b5cf6';
            ctx.fillRect(px + pw - 44, y + 2, 38, 18);
            ctx.fillStyle = '#000';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('SELL', px + pw - 25, y + 14);
            ctx.textAlign = 'left';
        });
    }
}

function drawCraftingPanel(ctx, px, py, pw) {
    const recipes = panelData.recipes;
    if (!recipes) { ctx.fillStyle = theme.textMuted || '#888'; ctx.font = '13px sans-serif'; ctx.fillText('Loading...', px + 10, py + 20); return; }

    // Rounded rect helper
    function rr(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
    }

    // Category tabs (pill-shaped)
    const tabW = Math.floor((pw - 16) / CRAFT_CATS.length);
    CRAFT_CATS.forEach((cat, i) => {
        const tx = px + 8 + i * tabW;
        const active = craftCategory === cat.id;
        rr(tx, py + 1, tabW - 2, 18, 4);
        ctx.fillStyle = active ? (theme.accent || '#8b5cf6') : (theme.bgCard || '#1a1a20');
        ctx.fill();
        if (active) {
            ctx.strokeStyle = theme.accent || '#8b5cf6';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.fillStyle = active ? '#000' : (theme.textDim || '#aaa');
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(cat.label, tx + tabW / 2, py + 13);
    });
    ctx.textAlign = 'left';

    // Filter recipes
    const filtered = craftCategory === 'all' ? recipes :
        recipes.filter(r => getRecipeCategory(r.output) === craftCategory);

    if (!filtered.length) {
        ctx.fillStyle = theme.textMuted || '#888';
        ctx.font = '12px sans-serif';
        ctx.fillText('No recipes in this category', px + 10, py + 46);
        return;
    }

    // Recipe list with modernized cards
    const cardH = 54, startY = py + 26;
    const maxVisible = Math.floor(340 / cardH);
    const scrolled = filtered.slice(craftScroll, craftScroll + maxVisible);
    scrolled.forEach((r, i) => {
        const y = startY + i * cardH;
        const rarCol = RARITY_COLORS[r.rarity] || '#aaa';
        const inputs = r.inputDetails || {};
        const canCraft = Object.entries(inputs).every(([id, d]) => (craftInventory[id] || 0) >= d.qty);

        // Card background (rounded)
        rr(px + 6, y, pw - 12, cardH - 4, 4);
        ctx.fillStyle = (theme.bgCard || '#1a1a20') + 'dd';
        ctx.fill();
        ctx.strokeStyle = canCraft ? (rarCol + '60') : (theme.border || '#333');
        ctx.lineWidth = 1;
        ctx.stroke();

        // Rarity accent bar (left)
        ctx.fillStyle = rarCol;
        ctx.fillRect(px + 6, y + 4, 3, cardH - 12);

        // Output item icon background circle
        const iconX = px + 22, iconY = y + (cardH - 4) / 2;
        ctx.beginPath();
        ctx.arc(iconX, iconY, 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fill();
        // Output emoji
        ctx.font = '16px serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText(r.outputEmoji || '❓', iconX, iconY + 5);

        // Item name + rarity
        ctx.textAlign = 'left';
        ctx.fillStyle = rarCol;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(r.name, px + 40, y + 15);

        // Station/level requirement badges
        let badgeX = px + 40 + ctx.measureText(r.name).width + 6;
        if (r.station) {
            const stIcons = { furnace: '🔥', workbench: '🔨', campfire: '🏕️' };
            ctx.font = '9px sans-serif';
            ctx.fillStyle = '#f59e0b';
            ctx.fillText(stIcons[r.station] || r.station, badgeX, y + 14);
            badgeX += 14;
        }
        if (r.smithingLevel) {
            ctx.font = '8px sans-serif';
            const smithLv = myPlayer?.smithing_level || 1;
            ctx.fillStyle = smithLv >= r.smithingLevel ? '#4fc94f' : '#ef4444';
            ctx.fillText(`Sm${r.smithingLevel}`, badgeX, y + 14);
        }

        // Materials row with icons
        let matX = px + 40;
        ctx.font = '10px sans-serif';
        for (const [itemId, detail] of Object.entries(inputs)) {
            const have = craftInventory[itemId] || 0;
            const need = detail.qty;
            ctx.fillStyle = have >= need ? '#4fc94f' : '#ef4444';
            const matStr = `${detail.emoji || '?'}${have}/${need}`;
            ctx.fillText(matStr, matX, y + 32);
            matX += ctx.measureText(matStr).width + 8;
            if (matX > px + pw - 60) break;
        }

        // CRAFT button (rounded pill)
        const btnX = px + pw - 56, btnY2 = y + 10, btnW = 44, btnH = 20;
        rr(btnX, btnY2, btnW, btnH, 4);
        ctx.fillStyle = canCraft ? (theme.accent || '#8b5cf6') : (theme.textMuted || '#444');
        ctx.fill();
        ctx.fillStyle = canCraft ? '#000' : '#888';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('CRAFT', btnX + btnW / 2, btnY2 + 14);
        ctx.textAlign = 'left';
    });

    // Scroll indicator (count)
    if (filtered.length > maxVisible) {
        ctx.fillStyle = theme.textMuted || '#888';
        ctx.font = '10px sans-serif';
        ctx.fillText(`↕ ${craftScroll + 1}–${Math.min(craftScroll + maxVisible, filtered.length)} of ${filtered.length}`, px + 10, startY + maxVisible * cardH + 12);
    }
}

function drawSkillsPanel(ctx, px, py, pw) {
    const p = panelData.player || myPlayer;
    if (!p) return;
    const skills = [
        { name: '⛏️ Mining', xp: p.mining_xp, level: p.mining_level },
        { name: '🎣 Fishing', xp: p.fishing_xp, level: p.fishing_level },
        { name: '🪓 Woodcutting', xp: p.woodcut_xp, level: p.woodcut_level },
        { name: '🌾 Farming', xp: p.farming_xp, level: p.farming_level },
        { name: '⚔️ Combat', xp: p.combat_xp, level: p.combat_level },
        { name: '🔨 Crafting', xp: p.crafting_xp, level: p.crafting_level },
        { name: '🔥 Smithing', xp: p.smithing_xp || 0, level: p.smithing_level || 1 },
        { name: '🏃 Agility', xp: p.agility_xp || 0, level: p.agility_level || 1 },
    ];
    skills.forEach((s, i) => {
        const y = py + i * 32;
        ctx.fillStyle = theme.text || '#eee';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(`${s.name}  Lv ${s.level || 1}`, px + 10, y + 18);
        const nextLvXp = ((s.level || 1)) * ((s.level || 1)) * 25;
        const pct = Math.min(1, (s.xp || 0) / Math.max(1, nextLvXp));
        ctx.fillStyle = theme.border || '#333';
        ctx.fillRect(px + 10, y + 22, pw - 20, 6);
        ctx.fillStyle = s.name.includes('Agility') ? '#22d3ee' : (theme.accent || '#8b5cf6');
        ctx.fillRect(px + 10, y + 22, (pw - 20) * pct, 6);
        // XP text
        ctx.fillStyle = theme.textDim || '#aaa';
        ctx.font = '9px sans-serif';
        ctx.fillText(`${s.xp || 0} / ${nextLvXp} XP`, px + 12, y + 30);
    });
    // Total
    const totalY = py + skills.length * 32 + 10;
    const totalLv = skills.reduce((s, sk) => s + (sk.level || 1), 0);
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`Total Level: ${totalLv}`, px + 10, totalY + 15);
    // Combat stats
    ctx.fillStyle = theme.text || '#ccc';
    ctx.font = '12px sans-serif';
    ctx.fillText(`⚔️ ATK: ${p.attack || 10}  🛡️ DEF: ${p.defense || 5}`, px + 10, totalY + 35);
    // Agility bonuses display
    if (p.agility_level > 1) {
        ctx.fillStyle = '#22d3ee';
        ctx.font = '11px sans-serif';
        const al = p.agility_level || 1;
        const sprintReduce = Math.min(50, al * 2);
        const dodgeReduce = Math.min(10, Math.floor(al * 0.5));
        const swimBonus = al * 2;
        ctx.fillText(`🏃 Agility: +${al * 2} Max STA | -${sprintReduce}% Sprint Cost | -${dodgeReduce} Dodge Cost | +${swimBonus}% Swim`, px + 10, totalY + 52);
    }
    // Equipment summary
    const eqY2 = p.agility_level > 1 ? totalY + 66 : totalY + 52;
    const eqParts = [];
    if (p.equip_weapon) eqParts.push(`⚔️ ${p.equip_weapon.replace(/^weapon_/, '')}`);
    if (p.equip_armor) eqParts.push(`🛡️ ${p.equip_armor.replace(/^armor_/, '')}`);
    if (eqParts.length) {
        ctx.fillStyle = theme.accent || '#8b5cf6';
        ctx.font = '11px sans-serif';
        ctx.fillText(eqParts.join('  '), px + 10, eqY2);
    }
    // Stats
    const statsY = eqParts.length ? eqY2 + 18 : eqY2;
    ctx.fillStyle = theme.textDim || '#aaa';
    ctx.font = '11px sans-serif';
    ctx.fillText(`Kills: ${p.total_monsters_killed || 0}  Deaths: ${p.total_deaths || 0}`, px + 10, statsY);
    ctx.fillText(`Built: ${p.structures_built || 0}  Gathered: ${p.resources_gathered || 0}`, px + 10, statsY + 16);
}

function drawQuestsPanel(ctx, px, py, pw) {
    const quests = panelData.quests || myDailyQuests;
    if (!quests.length) {
        ctx.fillStyle = theme.textMuted || '#888';
        ctx.font = '13px sans-serif';
        ctx.fillText('Loading daily quests...', px + 10, py + 20);
        return;
    }

    const resetMs = Math.max(0, new Date(dailyQuestMeta.nextResetAt || Date.now()).getTime() - Date.now());
    const hrs = Math.floor(resetMs / 3600000);
    const mins = Math.floor((resetMs % 3600000) / 60000);

    ctx.fillStyle = 'rgba(20, 24, 36, 0.85)';
    ctx.fillRect(px + 8, py + 6, pw - 16, 42);
    ctx.strokeStyle = 'rgba(251,191,36,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 8, py + 6, pw - 16, 42);
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`📜 ${dailyQuestMeta.claimed || 0}/${dailyQuestMeta.total || quests.length} claimed`, px + 16, py + 22);
    ctx.fillStyle = '#86efac';
    ctx.font = '11px sans-serif';
    ctx.fillText(`🔥 Streak ${dailyQuestMeta.streak || 0}`, px + 16, py + 37);
    ctx.fillStyle = theme.textDim || '#aaa';
    ctx.textAlign = 'right';
    ctx.fillText(`Resets in ${hrs}h ${mins}m`, px + pw - 16, py + 30);

    quests.forEach((quest, index) => {
        const y = py + 58 + index * 102;
        const claimed = !!quest.claimed;
        const completed = !!quest.completed;
        const cardColor = claimed ? 'rgba(34,197,94,0.12)' : completed ? 'rgba(251,191,36,0.12)' : 'rgba(30,30,40,0.6)';
        ctx.fillStyle = cardColor;
        ctx.fillRect(px + 8, y, pw - 16, 92);
        ctx.strokeStyle = claimed ? 'rgba(34,197,94,0.4)' : completed ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 8, y, pw - 16, 92);

        ctx.fillStyle = claimed ? '#86efac' : (completed ? '#fbbf24' : (theme.text || '#fff'));
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${quest.emoji || '📜'} ${quest.name}`, px + 16, y + 18);

        ctx.fillStyle = theme.textDim || '#aaa';
        ctx.font = '10px sans-serif';
        ctx.fillText(quest.desc, px + 16, y + 34);

        const barX = px + 16, barY = y + 44, barW = pw - 130, barH = 10;
        const pct = Math.max(0, Math.min(1, (quest.progress || 0) / Math.max(1, quest.target || 1)));
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = claimed ? '#22c55e' : completed ? '#fbbf24' : '#3b82f6';
        ctx.fillRect(barX, barY, barW * pct, barH);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.strokeRect(barX, barY, barW, barH);

        ctx.fillStyle = '#e5e7eb';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(`${Math.min(quest.progress || 0, quest.target || 0)}/${quest.target}`, barX, barY + 23);

        const rewardBits = [];
        if (quest.reward?.coins) rewardBits.push(`🪙 ${quest.reward.coins}`);
        if (quest.reward?.item) rewardBits.push(`${quest.reward.qty || 1}x ${(ITEMS[quest.reward.item] || {}).name || quest.reward.item}`);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '9px sans-serif';
        ctx.fillText(`Reward: ${rewardBits.join(' • ')}`, barX, y + 80);

        const btnX = px + pw - 88, btnY = y + 54, btnW = 64, btnH = 22;
        ctx.fillStyle = claimed ? '#166534' : completed ? '#f59e0b' : '#334155';
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.fillStyle = claimed ? '#dcfce7' : completed ? '#111827' : '#94a3b8';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(claimed ? 'CLAIMED' : completed ? 'CLAIM' : 'IN PROGRESS', btnX + btnW / 2, btnY + 15);
        ctx.textAlign = 'left';
    });
}

function drawLeaderboardPanel(ctx, px, py, pw) {
    const entries = panelData.leaderboard;
    if (!entries) { ctx.fillStyle = theme.textMuted || '#888'; ctx.fillText('Loading...', px + 10, py + 20); return; }
    entries.slice(0, 15).forEach((e, i) => {
        const y = py + i * 22;
        if (i % 2 === 0) { ctx.fillStyle = (theme.bgCard || '#1a1a20') + '44'; ctx.fillRect(px + 4, y + 2, pw - 8, 20); }
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
        ctx.fillStyle = i < 3 ? '#fbbf24' : (theme.text || '#ccc');
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${medal} ${e.display_name || e.username}`, px + 10, y + 16);
        ctx.fillStyle = theme.textDim || '#999';
        ctx.textAlign = 'right';
        ctx.fillText(`Score: ${e.score}`, px + pw - 10, y + 16);
        ctx.textAlign = 'left';
    });
}

function drawBuildPanel(ctx, px, py, pw) {
    const structs = [
        { id: 'wall_wood', name: '🟫 Wood Wall', cost: 'plank x3' },
        { id: 'wall_stone', name: '🧱 Stone Wall', cost: 'iron bar x2, gravel x5' },
        { id: 'door_wood', name: '🚪 Door', cost: 'plank x2, iron bar x1' },
        { id: 'floor_wood', name: '📋 Floor', cost: 'plank x2' },
        { id: 'workbench', name: '🔨 Workbench', cost: 'plank x5, iron bar x1' },
        { id: 'furnace', name: '🔥 Furnace', cost: 'gravel x10, iron bar x2' },
        { id: 'storage_box', name: '📦 Storage Box', cost: 'plank x3' },
        { id: 'sleeping_bag', name: '🛏️ Sleeping Bag', cost: 'wheat x5' },
        { id: 'campfire', name: '🏕️ Campfire', cost: 'oak log x5' },
        { id: 'tool_cupboard', name: '🧰 Tool Cupboard', cost: 'plank x5, iron bar x2' },
    ];
    ctx.fillStyle = '#aaa';
    ctx.font = '11px sans-serif';
    ctx.fillText('Click to select, then place on map', px + 10, py + 14);
    structs.forEach((s, i) => {
        const y = py + 22 + i * 30;
        const selected = selectedStructure === s.id;
        if (selected) { ctx.fillStyle = 'rgba(74,222,128,0.2)'; ctx.fillRect(px + 4, y, pw - 8, 28); }
        ctx.fillStyle = selected ? '#4ade80' : '#eee';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(s.name, px + 10, y + 16);
        ctx.fillStyle = '#888';
        ctx.font = '11px sans-serif';
        ctx.fillText(s.cost, px + 10, y + 26);
    });
}

function drawMapPanel(ctx, px, py, pw) {
    if (!minimapReady) { ctx.fillStyle = '#888'; ctx.fillText('Generating...', px + 10, py + 20); return; }
    const mapSize = Math.min(pw - 20, 320);
    ctx.drawImage(minimapCanvas, 0, 0, MAP_W, MAP_H, px + 10, py + 5, mapSize, mapSize);
    // Fog of war overlay — same as minimap
    if (fogCanvas) {
        ctx.drawImage(fogCanvas, 0, 0, MAP_W, MAP_H, px + 10, py + 5, mapSize, mapSize);
    }
    // Self marker
    if (myPlayer) {
        const sx = px + 10 + ((myPlayer.x / TILE) / MAP_W) * mapSize;
        const sy = py + 5 + ((myPlayer.y / TILE) / MAP_H) * mapSize;
        ctx.fillStyle = '#fff';
        ctx.fillRect(sx - 3, sy - 3, 6, 6);
        ctx.strokeStyle = '#000';
        ctx.strokeRect(sx - 3, sy - 3, 6, 6);
    }
    // Outpost label (only if explored)
    if (exploredTiles.has(`${OUTPOST_X},${OUTPOST_Y}`)) {
        const ox = px + 10 + (OUTPOST_X / MAP_W) * mapSize;
        const oy = py + 5 + (OUTPOST_Y / MAP_H) * mapSize;
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OUTPOST', ox, oy - 8);
        ctx.textAlign = 'left';
    }
}

// ── Fish Album Panel ─────────────────────────────────────────
function drawFishAlbumPanel(ctx, px, py, pw) {
    const data = panelData.fishCollection;
    if (!data) { ctx.fillStyle = '#888'; ctx.font = '13px sans-serif'; ctx.fillText('Loading...', px + 10, py + 20); return; }

    const collected = data.collected || [];
    const totalSpecies = data.totalSpecies || Object.keys(FISH_SPECIES).length;
    const progress = data.progress || 0;
    const collectedMap = {};
    for (const c of collected) collectedMap[c.fish_id] = c;

    // Progress bar
    const barW = pw - 20, barH = 14;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(px + 10, py + 2, barW, barH);
    const pct = totalSpecies > 0 ? progress / totalSpecies : 0;
    const barColor = pct >= 1 ? '#fbbf24' : pct > 0.5 ? '#22c55e' : '#3b82f6';
    ctx.fillStyle = barColor;
    ctx.fillRect(px + 10, py + 2, barW * pct, barH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 10, py + 2, barW, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${progress}/${totalSpecies} species discovered`, px + pw / 2, py + 12);

    // Milestone trophies
    const milestones = [5, 10, 15, 20, 25, 30];
    const trophyY = py + 20;
    ctx.font = '11px monospace';
    milestones.forEach((m, i) => {
        const tx = px + 12 + i * 54;
        const reached = progress >= m;
        ctx.fillStyle = reached ? '#fbbf24' : '#333';
        ctx.fillText(reached ? '🏆' : '🔒', tx, trophyY + 10);
        ctx.fillStyle = reached ? '#fbbf24' : '#666';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${m}`, tx + 14, trophyY + 10);
    });

    // Fish grid (5 columns)
    const COLS = 5, SLOT = 56, GAP = 4;
    const gridStartY = trophyY + 20;
    const gridW = COLS * (SLOT + GAP);
    const gridX = px + Math.floor((pw - gridW) / 2);
    const allSpecies = Object.entries(FISH_SPECIES);
    // Group by rod tier for display
    const rodLabels = ['🎋 Tier 1', '🥢 Tier 2', '⚫ Tier 3', '🔩 Tier 4', '💜 Tier 5'];

    let drawY = gridStartY - fishAlbumScroll;

    for (let tier = 0; tier <= 4; tier++) {
        const tierSpecies = allSpecies.filter(([_, s]) => s.rodTier === tier);
        if (!tierSpecies.length) continue;

        // Tier header
        if (drawY + 18 > gridStartY - 10 && drawY < gridStartY + 340) {
            ctx.fillStyle = theme.accent || '#8b5cf6';
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(rodLabels[tier] || `Tier ${tier + 1}`, gridX, drawY + 12);
        }
        drawY += 18;

        for (let i = 0; i < tierSpecies.length; i++) {
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            const sx = gridX + col * (SLOT + GAP);
            const sy = drawY + row * (SLOT + GAP);

            if (sy + SLOT < gridStartY || sy > gridStartY + 340) continue;

            const [fishId, spec] = tierSpecies[i];
            const caught = collectedMap[fishId];

            // Slot background
            ctx.fillStyle = caught ? (theme.bgCard || '#1a1a20') : '#111118';
            ctx.fillRect(sx, sy, SLOT, SLOT);
            ctx.strokeStyle = caught ? (RARITY_COLORS[spec.rarity] || '#444') : '#222';
            ctx.lineWidth = caught ? 1.5 : 0.5;
            ctx.strokeRect(sx, sy, SLOT, SLOT);

            if (caught) {
                // Show emoji + name
                ctx.font = '20px serif';
                ctx.textAlign = 'center';
                ctx.fillText(spec.emoji, sx + SLOT / 2, sy + 22);
                ctx.fillStyle = RARITY_COLORS[spec.rarity] || '#aaa';
                ctx.font = '8px monospace';
                ctx.fillText(spec.name, sx + SLOT / 2, sy + 35);
                // Best weight
                ctx.fillStyle = '#fbbf24';
                ctx.font = '8px monospace';
                ctx.fillText(`${caught.max_weight}lb`, sx + SLOT / 2, sy + 45);
                // Count
                ctx.fillStyle = '#888';
                ctx.fillText(`x${caught.times_caught}`, sx + SLOT / 2, sy + 53);
            } else {
                // Silhouette (undiscovered)
                ctx.font = '20px serif';
                ctx.textAlign = 'center';
                ctx.globalAlpha = 0.2;
                ctx.fillText(spec.emoji, sx + SLOT / 2, sy + 22);
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#444';
                ctx.font = '8px monospace';
                ctx.fillText('???', sx + SLOT / 2, sy + 35);
                // Show zone hints
                ctx.fillStyle = '#333';
                ctx.font = '7px monospace';
                const zoneIcons = { shallow: '🏖️', river: '🏞️', deep: '🌊', arctic: '❄️' };
                const zones = spec.zones.map(z => zoneIcons[z] || z).join('');
                ctx.fillText(zones, sx + SLOT / 2, sy + 48);
            }
        }
        drawY += Math.ceil(tierSpecies.length / COLS) * (SLOT + GAP) + 4;
    }

    ctx.textAlign = 'left';
}

// ── Achievements Panel ───────────────────────────────────────
let achScroll = 0;
let achCategory = 'all';
function drawAchievementsPanel(ctx, px, py, pw) {
    if (!myAchievements.length) {
        ctx.fillStyle = '#888'; ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText('Loading...', px + 10, py + 20); return;
    }

    const earned = myAchievements.filter(a => a.earned).length;
    const total = myAchievements.length;

    // Progress bar
    ctx.fillStyle = '#333';
    ctx.fillRect(px + 10, py + 4, pw - 20, 14);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(px + 10, py + 4, (pw - 20) * (earned / total), 14);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${earned} / ${total} Achievements`, px + pw / 2, py + 14);

    // Category tabs
    const cats = ['all', 'combat', 'gathering', 'fishing', 'crafting', 'exploration', 'milestones'];
    const catEmojis = { all: '📋', combat: '⚔️', gathering: '⛏️', fishing: '🎣', crafting: '🔨', exploration: '🗺️', milestones: '⭐' };
    let tabX = px + 5;
    const tabY = py + 22;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    for (const cat of cats) {
        const isActive = achCategory === cat;
        const tabW = 44;
        ctx.fillStyle = isActive ? 'rgba(251,191,36,0.3)' : 'rgba(50,50,50,0.5)';
        ctx.fillRect(tabX, tabY, tabW, 16);
        if (isActive) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1; ctx.strokeRect(tabX, tabY, tabW, 16); }
        ctx.fillStyle = isActive ? '#fbbf24' : '#888';
        ctx.fillText(`${catEmojis[cat] || ''} ${cat === 'all' ? 'All' : ''}`, tabX + tabW / 2, tabY + 12);
        tabX += tabW + 2;
    }

    // Filtered achievements
    const filtered = achCategory === 'all' ? myAchievements : myAchievements.filter(a => a.category === achCategory);
    const startY = tabY + 22;
    const rowH = 32;
    let drawY = startY - achScroll;

    ctx.textAlign = 'left';
    for (const ach of filtered) {
        if (drawY + rowH < py || drawY > py + 385) { drawY += rowH; continue; }
        // Background
        ctx.fillStyle = ach.earned ? 'rgba(251,191,36,0.08)' : 'rgba(30,30,40,0.5)';
        ctx.fillRect(px + 5, drawY, pw - 10, rowH - 2);
        if (ach.earned) {
            ctx.strokeStyle = 'rgba(251,191,36,0.3)';
            ctx.lineWidth = 1;
            ctx.strokeRect(px + 5, drawY, pw - 10, rowH - 2);
        }
        // Emoji
        ctx.font = '16px serif';
        ctx.globalAlpha = ach.earned ? 1 : 0.3;
        ctx.fillText(ach.emoji || '🏆', px + 10, drawY + 20);
        ctx.globalAlpha = 1;
        // Name
        ctx.font = ach.earned ? 'bold 11px sans-serif' : '11px sans-serif';
        ctx.fillStyle = ach.earned ? '#fbbf24' : '#666';
        ctx.fillText(ach.name, px + 32, drawY + 13);
        // Description
        ctx.font = '9px sans-serif';
        ctx.fillStyle = ach.earned ? '#a0a0a0' : '#555';
        ctx.fillText(ach.desc, px + 32, drawY + 25);
        // Reward (right side)
        if (ach.reward) {
            ctx.font = '8px sans-serif';
            ctx.fillStyle = ach.earned ? '#4ade80' : '#555';
            ctx.textAlign = 'right';
            ctx.fillText(`+${ach.reward.coins || 0}💰`, px + pw - 10, drawY + 18);
            ctx.textAlign = 'left';
        }
        drawY += rowH;
    }
}

// ══════════════════════════════════════════════════════════════
//  SERVER MESSAGE HANDLERS
// ══════════════════════════════════════════════════════════════

function handleGatherResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (!msg.success) return;
    refreshDailyQuests();
    // Trigger swing animation for tool use
    swingAnim = 1;
    swingType = msg.action || 'attack';
    const loot = msg.loot;
    const rarCol = RARITY_COLORS[loot.rarity] || '#fff';
    const icon = msg.action === 'punch' ? '👊' : msg.action === 'chop' ? '🪓' : msg.action === 'mine' ? '⛏️' : '🎣';
    const oreLabel = msg.oreType && msg.oreType !== 'stone' ? ` [${msg.oreType}]` : '';
    addChatMsg(`${icon} Got ${loot.emoji || ''} ${loot.name} (${loot.rarity})!${oreLabel}`);
    // Main loot float
    addFloatingText(myPlayer.x, myPlayer.y - 20, `+${loot.emoji} ${loot.name}`, rarCol);
    // XP float
    if (msg.xp?.totalXp) addFloatingText(myPlayer.x + 20, myPlayer.y - 10, `+${msg.xp.totalXp} XP`, '#3b82f6');
    // Particle burst — 6 sparkles radiating outward
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 / 6) * i;
        const dist = 12 + Math.random() * 10;
        addFloatingText(
            myPlayer.x + Math.cos(angle) * dist,
            myPlayer.y + Math.sin(angle) * dist - 8,
            '✦', rarCol
        );
    }
    // Screen flash for rare+ items
    if (['Rare', 'Epic', 'Legendary', 'Mythic'].includes(loot.rarity)) {
        const canvas = document.getElementById('gameCanvas');
        if (canvas) { canvas.classList.add('gather-flash'); setTimeout(() => canvas.classList.remove('gather-flash'), 300); }
    }
    if (msg.bonus) {
        addChatMsg('✨ Bonus drop!');
        addFloatingText(myPlayer.x - 15, myPlayer.y - 30, '✨ BONUS', '#f59e0b');
    }
    if (msg.xp?.leveledUp) {
        addChatMsg(`🎉 Level up! Now level ${msg.xp.newLevel}`);
        addFloatingText(myPlayer.x, myPlayer.y - 40, `⬆️ LEVEL ${msg.xp.newLevel}!`, '#fbbf24');
    }
    if (msg.toolBroke) {
        addChatMsg(`💥 Your ${msg.toolBroke} broke!`);
        // Clear the broken tool from local player state
        if (myPlayer) {
            if (myPlayer.equip_pickaxe === msg.toolBroke) myPlayer.equip_pickaxe = null;
            if (myPlayer.equip_axe === msg.toolBroke) myPlayer.equip_axe = null;
            if (myPlayer.equip_rod === msg.toolBroke) myPlayer.equip_rod = null;
        }
    }
    if (msg.stamina !== undefined) myPlayer.stamina = msg.stamina;

    // ── Update client-side XP so skills panel reflects changes immediately ──
    if (msg.xp && myPlayer) {
        const skillMap = { mine: 'mining', chop: 'woodcut', punch: 'woodcut', fish: 'fishing' };
        const skill = skillMap[msg.action] || 'mining';
        const xpKey = `${skill}_xp`;
        const lvlKey = `${skill}_level`;
        if (msg.xp.xp !== undefined) myPlayer[xpKey] = msg.xp.xp;
        if (msg.xp.newLevel) myPlayer[lvlKey] = msg.xp.newLevel;
        else if (msg.xp.xp !== undefined) myPlayer[lvlKey] = Math.floor(Math.sqrt((msg.xp.xp) / 25)) + 1;
    }

    lastGatherTime = Date.now();
}

function handleGatherEffect(msg) {
    const wx = msg.tileX * TILE + TILE / 2;
    const wy = msg.tileY * TILE + TILE / 2;
    const icon = msg.action === 'punch' ? '👊' : msg.action === 'chop' ? '🪓' : msg.action === 'mine' ? '⛏️' : '🎣';
    addFloatingText(wx, wy, icon, '#fff');
    // Mining particle burst
    if (msg.action === 'mine' && msg.tileX !== undefined && msg.tileY !== undefined) {
        const oreType = getOreNodeType(msg.tileX, msg.tileY, worldSeed,
            getBiomeAt(msg.tileX, msg.tileY, worldSeed));
        const ore = ORE_NODE_TYPES[oreType] || ORE_NODE_TYPES.stone;
        for (let i = 0; i < 8; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1.5 + Math.random() * 2.5;
            gatherParticles.push({
                x: wx, y: wy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 1.5,
                color: Math.random() > 0.5 ? ore.color : ore.highlight,
                life: 15 + Math.random() * 10,
                maxLife: 25,
                size: 1.5 + Math.random() * 2,
            });
        }
    }
    // Chopping particle burst
    if (msg.action === 'chop') {
        for (let i = 0; i < 5; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 2;
            gatherParticles.push({
                x: wx, y: wy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 1,
                color: Math.random() > 0.5 ? '#78350f' : '#15803d',
                life: 12 + Math.random() * 8,
                maxLife: 20,
                size: 1.5 + Math.random() * 1.5,
            });
        }
    }
}

function handleBuildResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        refreshDailyQuests();
        addChatMsg(`✅ Built ${msg.structure?.type || 'structure'}!`);
        if (msg.xp?.leveledUp) addChatMsg(`🎉 Crafting level up! ${msg.xp.newLevel}`);
        if (msg.xp && myPlayer) {
            if (msg.xp.xp !== undefined) myPlayer.crafting_xp = msg.xp.xp;
            if (msg.xp.newLevel) myPlayer.crafting_level = msg.xp.newLevel;
        }
    }
}

function handleAttackResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        const comboTxt = msg.combo > 1 ? ` (x${msg.combo} Combo!)` : '';
        addChatMsg(`⚔️ Hit for ${msg.dmg} damage${msg.isCrit ? ' (CRIT!)' : ''}${comboTxt}`);
        if (msg.isCrit) shakeIntensity = 6;
        swingAnim = 1;
        swingType = 'attack';
        if (msg.combo > 1) {
            comboCount = msg.combo;
            comboTimer = COMBO_DISPLAY_MS;
        }
        if (msg.weaponSpeed) updateWeaponCooldown(msg.weaponSpeed);
        if (msg.killed) addChatMsg('💀 Enemy killed!');
    }
}

function handleMobAttackResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        if (msg.isCrit) shakeIntensity = 6;
        swingAnim = 1;
        swingType = 'attack';
        // Combo display
        if (msg.combo > 1) {
            comboCount = msg.combo;
            comboTimer = COMBO_DISPLAY_MS;
            addFloatingText(msg.mobX || myPlayer.x, (msg.mobY || myPlayer.y) - 50,
                `x${msg.combo} COMBO!`, '#f59e0b');
        }
        if (msg.weaponSpeed) updateWeaponCooldown(msg.weaponSpeed);
        addFloatingText(msg.mobX || myPlayer.x, (msg.mobY || myPlayer.y) - 20,
            `${msg.isCrit ? '💥' : ''}-${msg.dmg}`, msg.isCrit ? '#f59e0b' : '#fff');
        if (msg.killed) {
            refreshDailyQuests();
            addChatMsg(`💀 Killed ${msg.mobName}! +${msg.xp?.gained || 0} XP, +${msg.gold} 🪙`);
            if (msg.loot) {
                addChatMsg(`🎁 Loot: ${msg.loot.emoji || '📦'} ${msg.loot.name}`);
                addFloatingText(msg.mobX || myPlayer.x, (msg.mobY || myPlayer.y) - 40,
                    `${msg.loot.emoji || '📦'} ${msg.loot.name}`, '#a855f7');
            }
            shakeIntensity = 4;
            comboCount = 0; comboTimer = 0;
            if (myPlayer && msg.gold) myPlayer.openvibe_coins = (myPlayer.openvibe_coins || 0) + msg.gold;
            // Update combat XP on client
            if (msg.xp && myPlayer) {
                if (msg.xp.xp !== undefined) myPlayer.combat_xp = msg.xp.xp;
                if (msg.xp.newLevel) myPlayer.combat_level = msg.xp.newLevel;
            }
        }
    }
}

function handleMobHitPlayer(msg) {
    if (msg.dodged) {
        addChatMsg(`💨 Dodged ${msg.mobName}'s attack!`);
        addFloatingText(myPlayer.x, myPlayer.y - 20, 'DODGED!', '#60a5fa');
        return;
    }
    addChatMsg(`🐾 ${msg.mobName} hit you for ${msg.dmg}! HP: ${msg.hp}/${msg.maxHp}`);
    if (myPlayer) { myPlayer.hp = msg.hp; myPlayer.max_hp = msg.maxHp; }
    addFloatingText(myPlayer.x, myPlayer.y - 20, `-${msg.dmg}`, '#ef4444');
    shakeIntensity = 4;
    if (msg.hp <= 0) isDead = true;
}

function handleMobKilled(msg) {
    if (String(msg.userId) !== String(myUserId)) {
        addChatMsg(`⚔️ ${msg.username} killed a ${msg.mobName}!`);
    }
    // Death particle effect at mob position
    if (msg.mobX && msg.mobY) {
        addFloatingText(msg.mobX, msg.mobY - 10, `${msg.mobEmoji || '💀'}`, '#ef4444');
    }
}

function handleCombatHit(msg) {
    addChatMsg(`💥 Hit for ${msg.dmg}${msg.isCrit ? ' CRIT' : ''}! HP: ${msg.hp}/${msg.maxHp}`);
    if (myPlayer) { myPlayer.hp = msg.hp; myPlayer.max_hp = msg.maxHp; }
    addFloatingText(myPlayer.x, myPlayer.y - 20, `-${msg.dmg}`, '#ef4444');
    shakeIntensity = msg.isCrit ? 8 : 4;
    if (msg.hp <= 0) {
        isDead = true;
    }
}

function handlePlayerDied(msg) {
    addChatMsg(`💀 ${msg.killerName} killed a player!`);
    // Spawn death drop scatter animation if we have position data
    if (msg.dropped && msg.dropped.length && msg.deathX && msg.deathY) {
        for (const d of msg.dropped) {
            deathDropAnims.push({
                emoji: d.emoji || '📦',
                name: d.name,
                qty: d.qty,
                startX: msg.deathX,
                startY: msg.deathY,
                targetX: d.x, targetY: d.y,
                progress: 0, // 0→1 animation progress
                life: 60,    // frames
            });
        }
    }
}

function handlePickupResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        const item = msg.item;
        addChatMsg(`📦 Picked up ${item.emoji || ''} ${item.name} x${item.qty}`);
        addFloatingText(myPlayer.x, myPlayer.y - 20, `+${item.emoji} ${item.name}`, RARITY_COLORS[item.rarity] || '#fff');
        delete groundItems[msg.groundId];
        // Reload inventory for hotbar update
        loadPanelData('inventory');
    }
}

function handleChestResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        refreshDailyQuests();
        delete chests[msg.chestId];
        const tierEmojis = { wooden: '📦', silver: '🥈', gold: '🥇', crystal: '💎' };
        const tierNames = { wooden: 'Wooden', silver: 'Silver', gold: 'Gold', crystal: 'Crystal' };
        const loot = msg.loot || [];
        addChatMsg(`${tierEmojis[msg.tier] || '📦'} Opened ${tierNames[msg.tier]} Chest! +${msg.coins} coins${loot.length ? ', ' + loot.map(i => `${i.emoji} ${i.name} x${i.qty}`).join(', ') : ''}`);
        if (myPlayer) {
            addFloatingText(myPlayer.x, myPlayer.y - 30, `🎁 +${msg.coins} coins!`, '#fbbf24');
            myPlayer.openvibe_coins = (myPlayer.openvibe_coins || 0) + msg.coins;
        }
        loadPanelData('inventory');
    }
}

function handleAchievementsEarned(msg) {
    for (const ach of msg.achievements) {
        achievementToasts.push({ text: ach.name, emoji: ach.emoji, desc: ach.desc, timer: 240 }); // ~4s at 60fps
        addChatMsg(`🏆 Achievement Unlocked: ${ach.emoji} ${ach.name} — ${ach.desc}`);
        // Update local achievement list
        const existing = myAchievements.find(a => a.id === ach.id);
        if (existing) existing.earned = true;
        else myAchievements.push({ ...ach, earned: true });
    }
}

function handleRespawn(msg) {
    isDead = true;
    deathDropped = msg.dropped || [];
    // Spawn death drop scatter animation
    if (msg.dropped && msg.dropped.length && msg.deathX && msg.deathY) {
        for (const d of msg.dropped) {
            if (d.x && d.y) {
                deathDropAnims.push({
                    emoji: d.emoji || '📦',
                    name: d.name,
                    qty: d.qty,
                    startX: msg.deathX,
                    startY: msg.deathY,
                    targetX: d.x, targetY: d.y,
                    progress: 0,
                    life: 60,
                });
            }
        }
    }
    // Player will click to dismiss death screen
    myPlayer.x = msg.x;
    myPlayer.y = msg.y;
    myPlayer.hp = myPlayer.max_hp || 100;
    playerVelX = 0;
    playerVelY = 0;
}

// ══════════════════════════════════════════════════════════════
//  INPUT
// ══════════════════════════════════════════════════════════════

function setupGameInput() {
    // Already set up
    if (window._gameInputReady) return;
    window._gameInputReady = true;

    document.addEventListener('keydown', (e) => {
        if (currentPage !== 'game') return;
        // Don't capture keys when typing in DOM inputs (floating chat widget, etc)
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        keys[e.code] = true;

        // Chat input mode
        if (chatOpen) {
            if (e.code === 'Escape') { chatOpen = false; chatInput = ''; e.preventDefault(); return; }
            if (e.code === 'Enter') {
                if (chatInput.trim()) sendWs({ type: 'chat', text: chatInput.trim() });
                chatOpen = false; chatInput = ''; e.preventDefault(); return;
            }
            if (e.code === 'Backspace') { chatInput = chatInput.slice(0, -1); e.preventDefault(); return; }
            if (e.key.length === 1) { chatInput += e.key; e.preventDefault(); }
            return;
        }

        // Prevent scrolling
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();

        switch (e.code) {
            case 'Enter': chatOpen = true; e.preventDefault(); break;
            case 'Escape':
                if (FISHING.active) { exitFishingMode(); }
                else if (activePanel) { panelAnimDir = -1; panelClosingTo = null; activeNPC = null; npcShopData = null; invGridHeldItem = null; }
                else if (buildMode) { buildMode = false; selectedStructure = null; }
                break;
            case 'KeyE': {
                if (FISHING.active) break;
                // E key: interact with NPC, enter fishing mode, or pick up ground items
                const nearNpc = getNearestNPC();
                if (nearNpc) { interactWithNPC(nearNpc); break; }
                // Check for nearby water tile for fishing
                if (myPlayer && myPlayer.equip_rod) {
                    const ptx = Math.floor(myPlayer.x / TILE), pty = Math.floor(myPlayer.y / TILE);
                    let waterTile = null;
                    for (let dy = -2; dy <= 2 && !waterTile; dy++) {
                        for (let dx = -2; dx <= 2 && !waterTile; dx++) {
                            if (getBiomeAt(ptx + dx, pty + dy, worldSeed) === 'water') waterTile = { x: ptx + dx, y: pty + dy };
                        }
                    }
                    if (waterTile) { enterFishingMode(waterTile.x, waterTile.y); break; }
                }
                // Try to pick up nearest ground item
                doPickup();
                break;
            }
            case 'KeyB': togglePanel('build'); buildMode = !buildMode; break;
            case 'KeyI': togglePanel('inventory'); break;
            case 'KeyK': togglePanel('skills'); break;
            case 'KeyG': togglePanel('quests'); break;
            case 'KeyM': togglePanel('map'); break;
            case 'KeyL': togglePanel('leaderboard'); break;
            case 'KeyC': togglePanel('crafting'); break;
            case 'KeyF': togglePanel('fish_album'); break;
            case 'KeyJ': togglePanel('achievements'); break;
            // ── Hotbar 1-9 keys ──
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6':
            case 'Digit7': case 'Digit8': case 'Digit9': {
                if (FISHING.active || isDead) break;
                const slotIdx = parseInt(e.code.charAt(5)) - 1; // 0-8
                selectHotbarSlot(slotIdx);
                e.preventDefault();
                break;
            }
            case 'Space': {
                // Jump (visual z-axis hop)
                if (FISHING.active || chatOpen || isDead) break;
                if (isJumping || Date.now() < jumpCooldownUntil) break;
                const ptxJ = Math.floor(myPlayer.x / TILE);
                const ptyJ = Math.floor(myPlayer.y / TILE);
                const jBiome = worldSeed && getBiomeAt(ptxJ, ptyJ, worldSeed);
                if (jBiome === 'water') break; // Can't jump in water
                isJumping = true;
                // Sprint-jump goes higher and farther
                const sprintJumpBonus = isSprinting ? 1.35 : 1.0;
                jumpVelocity = JUMP_STRENGTH * sprintJumpBonus;
                jumpHeight = 0.1;
                jumpCooldownUntil = Date.now() + JUMP_COOLDOWN_MS;
                break;
            }
            case 'KeyQ': {
                // Dodge roll
                if (FISHING.active || chatOpen || isDead) break;
                if (Date.now() < dodgeCooldownUntil) { addChatMsg('💨 Dodge on cooldown!'); break; }
                const ddx = Math.cos(facingAngle);
                const ddy = Math.sin(facingAngle);
                sendWs({ type: 'dodge', dx: ddx, dy: ddy });
                break;
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        // Always clear key state on up (even if focus changed mid-press)
        keys[e.code] = false;
    });

    const canvas = document.getElementById('game-canvas');
    if (canvas) {
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = CAM_W / rect.width, scaleY = CAM_H / rect.height;
            mouseX = (e.clientX - rect.left) * scaleX;
            mouseY = (e.clientY - rect.top) * scaleY;
        });

        canvas.addEventListener('click', (e) => {
            if (isDead) { isDead = false; deathDropped = []; return; }

            // Fishing mini-game click handling
            if (FISHING.active) {
                handleFishingClick();
                return;
            }

            const pw = 340, ph = 420;
            const panelX = CAM_W - pw - 15, panelY = 130;

            // Cancel any held inventory drag if clicking outside inventory panel
            if (invGridHeldItem) {
                const inInvPanel = activePanel === 'inventory' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph;
                if (!inInvPanel) {
                    invGridHeldItem = null;
                    return;
                }
            }

            // Build panel click detection
            if (activePanel === 'build') {
                if (mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY + 22 && mouseY <= panelY + ph) {
                    const idx = Math.floor((mouseY - panelY - 22) / 30);
                    const structIds = ['wall_wood', 'wall_stone', 'door_wood', 'floor_wood', 'workbench', 'furnace', 'storage_box', 'sleeping_bag', 'campfire', 'tool_cupboard'];
                    if (idx >= 0 && idx < structIds.length) {
                        selectedStructure = structIds[idx];
                        buildMode = true;
                        addChatMsg(`Selected ${selectedStructure}. Click on map to place.`);
                    }
                    return;
                }
            }

            // Achievement panel tab clicks
            if (activePanel === 'achievements' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const contentY = panelY + 35;
                const tabY = contentY + 22;
                if (mouseY >= tabY && mouseY <= tabY + 16) {
                    const cats = ['all', 'combat', 'gathering', 'fishing', 'crafting', 'exploration', 'milestones'];
                    const tabW = 46;
                    const tabIdx = Math.floor((mouseX - panelX - 5) / tabW);
                    if (tabIdx >= 0 && tabIdx < cats.length) {
                        achCategory = cats[tabIdx];
                        achScroll = 0;
                    }
                }
                return;
            }

            if (activePanel === 'quests' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const contentY = panelY + 35;
                const quests = panelData.quests || myDailyQuests;
                quests.forEach((quest, index) => {
                    if (!quest.completed || quest.claimed) return;
                    const rowY = contentY + 58 + index * 102;
                    const btnX = panelX + pw - 88;
                    const btnY = rowY + 54;
                    if (mouseX >= btnX && mouseX <= btnX + 64 && mouseY >= btnY && mouseY <= btnY + 22) {
                        claimDailyQuest(quest.id);
                    }
                });
                return;
            }

            // Crafting panel clicks
            if (activePanel === 'crafting' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const contentY = panelY + 35;
                // Tab clicks (inside content area top 18px)
                if (mouseY >= contentY && mouseY <= contentY + 18) {
                    const tabW = Math.floor((pw - 20) / CRAFT_CATS.length);
                    const tabIdx = Math.floor((mouseX - panelX - 10) / tabW);
                    if (tabIdx >= 0 && tabIdx < CRAFT_CATS.length) {
                        craftCategory = CRAFT_CATS[tabIdx].id;
                        craftScroll = 0;
                    }
                    return;
                }
                // Recipe CRAFT button clicks
                const recipes = panelData.recipes || [];
                const filtered = craftCategory === 'all' ? recipes :
                    recipes.filter(r => getRecipeCategory(r.output) === craftCategory);
                const cardH = 50, startY = contentY + 24;
                const visIndex = Math.floor((mouseY - startY) / cardH);
                const recipeIdx = visIndex + craftScroll;
                if (recipeIdx >= 0 && recipeIdx < filtered.length) {
                    const r = filtered[recipeIdx];
                    // Check if click is on the CRAFT button area (right side)
                    const btnX = panelX + pw - 54;
                    if (mouseX >= btnX) {
                        craftRecipe(r.id);
                    }
                }
                return;
            }

            // Inventory panel clicks — grid-based + equipment slots + sonar button
            if (activePanel === 'inventory' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const items = panelData.inventory || [];
                const contentY = panelY + 35;
                const SLOT = 38, GAP = 3, COLS = 7, EQUIP_SLOT = 42;
                const eqX = panelX + 6, eqStartY = contentY + 18;

                const EQUIP_CAT_TO_SLOT = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
                const equipSlots = [
                    { key: 'equip_weapon', cat: 'weapons' },
                    { key: 'equip_armor', cat: 'armor' },
                    { key: 'equip_hat', cat: 'hats' },
                    { key: 'equip_pickaxe', cat: 'pickaxes' },
                    { key: 'equip_axe', cat: 'axes' },
                    { key: 'equip_rod', cat: 'rods' },
                ];

                // Check equipment slot clicks — drop held item into matching slot, or show info
                for (let i = 0; i < equipSlots.length; i++) {
                    const row = i % 3, col = Math.floor(i / 3);
                    const sx = eqX + col * (EQUIP_SLOT + GAP);
                    const sy = eqStartY + row * (EQUIP_SLOT + GAP);
                    if (mouseX >= sx && mouseX <= sx + EQUIP_SLOT && mouseY >= sy && mouseY <= sy + EQUIP_SLOT) {
                        // If holding a dragged item, try equipping it to this slot
                        if (invGridHeldItem) {
                            const heldCat = invGridHeldItem.category || '';
                            if (EQUIP_CAT_TO_SLOT[heldCat] === equipSlots[i].key) {
                                // Matching slot — equip via API
                                handleEquipDrop(invGridHeldItem);
                                invGridHeldItem = null;
                            } else {
                                addChatMsg(`❌ Can't equip ${invGridHeldItem.emoji || ''} ${invGridHeldItem.name} in the ${equipSlots[i].cat} slot`);
                                invGridHeldItem = null;
                            }
                        } else {
                            // Not holding anything — unequip the item from this slot
                            if (myPlayer?.[equipSlots[i].key]) {
                                const eqId = myPlayer[equipSlots[i].key];
                                const eqItem = items.find(it => it.item_id === eqId);
                                handleUnequipSlot(equipSlots[i].cat, eqId, eqItem);
                            }
                        }
                        return;
                    }
                }

                // Check sonar button click
                const hasSonar = items.some(it => it.item_id === 'fish_sonar');
                if (hasSonar) {
                    const btnX = panelX + 6 + 2 * (EQUIP_SLOT + GAP), btnY = eqStartY + 2 * (EQUIP_SLOT + GAP);
                    if (mouseX >= btnX && mouseX <= btnX + EQUIP_SLOT && mouseY >= btnY && mouseY <= btnY + EQUIP_SLOT) {
                        if (invGridHeldItem) { invGridHeldItem = null; } // cancel drag
                        doUseSonar();
                        return;
                    }
                }

                // Check grid slot clicks — pick up equippable items for drag, or direct-use others
                const gridStartY = eqStartY + 3 * (EQUIP_SLOT + GAP) + 8;
                const gridW = COLS * (SLOT + GAP);
                const gridX = panelX + Math.floor((pw - gridW) / 2);
                const availH = 380 - (gridStartY - contentY);
                const ROWS = Math.max(1, Math.floor(availH / (SLOT + GAP)));

                if (mouseX >= gridX && mouseX <= gridX + gridW && mouseY >= gridStartY && mouseY <= gridStartY + ROWS * (SLOT + GAP)) {
                    const gCol = Math.floor((mouseX - gridX) / (SLOT + GAP));
                    const gRow = Math.floor((mouseY - gridStartY) / (SLOT + GAP));
                    const gIdx = (gRow + invGridScroll) * COLS + gCol;
                    if (gCol >= 0 && gCol < COLS && gIdx >= 0 && gIdx < items.length) {
                        const clickedItem = items[gIdx];

                        // If already holding an item, drop it (cancel drag)
                        if (invGridHeldItem) {
                            invGridHeldItem = null;
                            return;
                        }

                        // Equipment items → pick up for drag-and-drop
                        if (EQUIP_CAT_TO_SLOT[clickedItem.category]) {
                            invGridHeldItem = { ...clickedItem, fromSlot: gIdx };
                            return;
                        }

                        // Non-equippable items → direct click action (use, eat, activate)
                        handleInventoryClick(clickedItem);
                    }
                }

                // Clicked inside panel but not on any slot — cancel any drag
                if (invGridHeldItem) { invGridHeldItem = null; }
                return;
            }

            // NPC Shop panel clicks
            if ((activePanel === 'npc_shop' || activePanel === 'shop') && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const contentY = panelY + 35;
                // Tab clicks (Buy/Sell)
                if (mouseY >= contentY + 16 && mouseY <= contentY + 34) {
                    const tabW = (pw - 20) / 2;
                    const tabIdx = Math.floor((mouseX - panelX - 10) / tabW);
                    if (tabIdx === 0) { npcShopTab = 'buy'; npcShopScroll = 0; }
                    else if (tabIdx === 1) { npcShopTab = 'sell'; npcShopScroll = 0; }
                    return;
                }
                // Item clicks (buy/sell buttons on right side)
                const startY = contentY + 40;
                const rowIdx = Math.floor((mouseY - startY) / 24);
                if (rowIdx >= 0 && mouseX >= panelX + pw - 44) {
                    const actualIdx = rowIdx + npcShopScroll;
                    if (npcShopTab === 'buy') {
                        const items = (npcShopData?.items || []).filter(i => i.buyCost !== null);
                        if (actualIdx < items.length) npcBuyItem(items[actualIdx].id);
                    } else {
                        const inv = npcShopData?.inventory || [];
                        const npc = NPCS.find(n => n.id === activeNPC);
                        const sellable = inv.filter(i => i.sellPrice && (!npc || !npc.categories?.length || npc.categories.includes(i.category)));
                        if (actualIdx < sellable.length) npcSellItem(sellable[actualIdx].item_id);
                    }
                }
                return;
            }

            // Bank panel clicks
            if (activePanel === 'bank' && mouseX >= panelX && mouseX <= panelX + pw && mouseY >= panelY && mouseY <= panelY + ph) {
                const contentY = panelY + 35;
                // Tab clicks (Deposit/Withdraw)
                if (mouseY >= contentY && mouseY <= contentY + 18) {
                    const tabW = (pw - 20) / 2;
                    const tabIdx = Math.floor((mouseX - panelX - 10) / tabW);
                    if (tabIdx === 0) { npcShopTab = 'deposit'; npcShopScroll = 0; }
                    else if (tabIdx === 1) { npcShopTab = 'withdraw'; npcShopScroll = 0; }
                    return;
                }
                // Item action buttons
                const startY = contentY + 24;
                const rowIdx = Math.floor((mouseY - startY) / 22);
                if (rowIdx >= 0 && mouseX >= panelX + pw - 44) {
                    const actualIdx = rowIdx + npcShopScroll;
                    const items = npcShopTab === 'deposit' ? (panelData.inventory || []) : (panelData.bank || []);
                    if (actualIdx < items.length) {
                        if (npcShopTab === 'deposit') bankAction('deposit', items[actualIdx].item_id);
                        else bankAction('withdraw', items[actualIdx].item_id);
                    }
                }
                return;
            }

            // Build mode placement
            if (buildMode && selectedStructure) {
                const tx = Math.floor((mouseX + camX) / TILE);
                const ty = Math.floor((mouseY + camY) / TILE);
                sendWs({ type: 'build', structureType: selectedStructure, tileX: tx, tileY: ty });
                return;
            }

            // Attack player or mob on click, or gather resource node, or pickup ground item
            const worldClickX = mouseX + camX;
            const worldClickY = mouseY + camY;
            const now = Date.now();

            // Check ground item clicks first (pickup on click)
            for (const [gid, gi] of Object.entries(groundItems)) {
                const dist = Math.sqrt((gi.x - worldClickX) ** 2 + (gi.y - worldClickY) ** 2);
                if (dist < 18) {
                    sendWs({ type: 'pickup', groundItemId: parseInt(gid) });
                    return;
                }
            }

            // Check treasure chest clicks (open on click)
            for (const [cid, ch] of Object.entries(chests)) {
                const dist = Math.sqrt((ch.x - worldClickX) ** 2 + (ch.y - worldClickY) ** 2);
                if (dist < 20) {
                    sendWs({ type: 'open_chest', chestId: parseInt(cid) });
                    return;
                }
            }

            // Check resource node clicks (click-to-gather)
            const clickTileX = Math.floor(worldClickX / TILE);
            const clickTileY = Math.floor(worldClickY / TILE);
            // Check clicked tile and adjacent tiles for a node
            for (let dy = 0; dy <= 0; dy++) {
                for (let dx = 0; dx <= 0; dx++) {
                    const tx = clickTileX + dx, ty = clickTileY + dy;
                    const node = getResourceNodeAt(tx, ty, worldSeed);
                    if (node && !depletedNodes.has(`${tx},${ty}`)) {
                        if (now - lastGatherTime < 1000) return; // gather cooldown
                        lastGatherTime = now;
                        // Face toward clicked node
                        const nodeCX = tx * TILE + TILE / 2, nodeCY = ty * TILE + TILE / 2;
                        facingAngle = Math.atan2(nodeCY - myPlayer.y, nodeCX - myPlayer.x);
                        swingAnim = 1;
                        swingType = node.type === 'rock' ? 'mine' : node.type === 'tree' ? 'chop' : 'punch';
                        sendWs({ type: 'gather', tileX: tx, tileY: ty });
                        return;
                    }
                }
            }

            // Enforce attack cooldown
            if (now - lastAttackTime < attackCooldown) return;

            // Weapon range for click detection
            const wepId = myPlayer?.equip_weapon || 'weapon_fist';
            const wepInfo = serverWeaponStats[wepId] || serverWeaponStats['weapon_fist'] || { range: 1.0 };
            const clickRange = 20 * (wepInfo.range || 1.0);

            // Check mob clicks first
            for (const [mid, mob] of Object.entries(mobs)) {
                const dist = Math.sqrt((mob.x - worldClickX) ** 2 + (mob.y - worldClickY) ** 2);
                if (dist < clickRange) {
                    lastAttackTime = now;
                    facingAngle = Math.atan2(mob.y - myPlayer.y, mob.x - myPlayer.x);
                    swingAnim = 1; swingType = 'attack';
                    sendWs({ type: 'attack_mob', mobId: parseInt(mid) });
                    return;
                }
            }

            // Check player clicks
            for (const [uid, p] of Object.entries(players)) {
                if (String(uid) === String(myUserId)) continue;
                const dist = Math.sqrt((p.x - worldClickX) ** 2 + (p.y - worldClickY) ** 2);
                if (dist < clickRange) {
                    lastAttackTime = now;
                    facingAngle = Math.atan2(p.y - myPlayer.y, p.x - myPlayer.x);
                    swingAnim = 1; swingType = 'attack';
                    sendWs({ type: 'attack', targetId: parseInt(uid) });
                    return;
                }
            }

            // Nothing clicked — swing fist toward click point
            facingAngle = Math.atan2(worldClickY - myPlayer.y, worldClickX - myPlayer.x);
            swingAnim = 1;
            swingType = 'punch';
        });

        // Panel scroll wheel
        canvas.addEventListener('wheel', (e) => {
            const pw = 340, panelX = CAM_W - pw - 15, panelY = 130, ph = 420;
            if (mouseX < panelX || mouseX > panelX + pw || mouseY < panelY || mouseY > panelY + ph) return;
            e.preventDefault();
            const dir = e.deltaY > 0 ? 1 : -1;

            if (activePanel === 'crafting') {
                const recipes = panelData.recipes || [];
                const filtered = craftCategory === 'all' ? recipes :
                    recipes.filter(r => getRecipeCategory(r.output) === craftCategory);
                const maxScroll = Math.max(0, filtered.length - Math.floor(320 / 50));
                craftScroll = Math.max(0, Math.min(maxScroll, craftScroll + dir));
            } else if (activePanel === 'inventory') {
                const items = panelData.inventory || [];
                const COLS = 7, SLOT = 38, GAP = 3, EQUIP_SLOT = 42;
                const contentY = 130 + 35;
                const gridStartY = contentY + 18 + 3 * (EQUIP_SLOT + GAP) + 8;
                const availH = 380 - (gridStartY - contentY);
                const ROWS = Math.max(1, Math.floor(availH / (SLOT + GAP)));
                const maxScroll = Math.max(0, Math.ceil(items.length / COLS) - ROWS);
                invGridScroll = Math.max(0, Math.min(maxScroll, invGridScroll + dir));
            } else if (activePanel === 'npc_shop' || activePanel === 'shop') {
                const data = npcShopData;
                if (!data) return;
                let listLen = 0;
                if (npcShopTab === 'buy') listLen = (data.items || []).length;
                else listLen = (data.inventory || []).filter(it => {
                    const npc = NPCS.find(n => n.id === activeNPC);
                    return npc && npc.categories.includes(it.category);
                }).length;
                const maxScroll = Math.max(0, listLen - 13);
                npcShopScroll = Math.max(0, Math.min(maxScroll, npcShopScroll + dir));
            } else if (activePanel === 'bank') {
                const inv = panelData.inventory || [];
                const bank = panelData.bank || [];
                const listLen = npcShopTab === 'deposit' ? inv.length : bank.length;
                const maxScroll = Math.max(0, listLen - 14);
                npcShopScroll = Math.max(0, Math.min(maxScroll, npcShopScroll + dir));
            } else if (activePanel === 'fish_album') {
                fishAlbumScroll = Math.max(0, fishAlbumScroll + dir * 30);
            }
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (buildMode) { buildMode = false; selectedStructure = null; addChatMsg('Build mode off'); }
        });
    }
}

// ── Crafting + Inventory click helpers ───────────────────────
async function craftRecipe(recipeId) {
    try {
        const res = await api('/game/craft', { method: 'POST', body: JSON.stringify({ recipeId }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        const craftedItem = res.output || res.item || {};
        addChatMsg(`🔨 Crafted ${craftedItem.emoji || ''} ${craftedItem.name || recipeId}!`);
        addFloatingText(myPlayer.x, myPlayer.y - 20, `+${craftedItem.emoji || '✨'} ${craftedItem.name || 'item'}`, RARITY_COLORS[craftedItem.rarity] || '#fff');
        if (res.xp?.leveledUp) addChatMsg(`🎉 Crafting level up! ${res.xp.newLevel}`);
        if (res.recipeUnlocked) addChatMsg(`📜 New recipe unlocked: ${res.recipeUnlocked}`);
        refreshDailyQuests();
        // Refresh crafting data
        loadPanelData('crafting');
    } catch (err) {
        addChatMsg('❌ Crafting failed');
    }
}

// ── Drag-and-drop equip handler ──
async function handleEquipDrop(item) {
    if (!item) return;
    const cat = item.category || '';
    const EQUIP_SLOT_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
    if (!EQUIP_SLOT_MAP[cat]) return;
    try {
        const res = await api('/game/equip', { method: 'POST', body: JSON.stringify({ itemId: item.item_id }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        addChatMsg(`✅ Equipped ${item.emoji || ''} ${item.name}!`);
        const slotKey = EQUIP_SLOT_MAP[cat];
        if (myPlayer) myPlayer[slotKey] = item.item_id;
        if (cat === 'weapons') updateWeaponCooldown();
        assignToHotbar(item);
        loadPanelData('inventory');
    } catch (err) { addChatMsg('❌ Equip failed'); }
}

// ── Unequip handler — remove item from equipment slot ──
async function handleUnequipSlot(slotCategory, itemId, item) {
    try {
        const res = await api('/game/unequip', { method: 'POST', body: JSON.stringify({ slot: slotCategory }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        addChatMsg(`🔓 Unequipped ${item?.emoji || ''} ${item?.name || itemId}`);
        const EQUIP_SLOT_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
        const slotKey = EQUIP_SLOT_MAP[slotCategory];
        if (myPlayer && slotKey) myPlayer[slotKey] = null;
        if (slotCategory === 'weapons') updateWeaponCooldown();
        loadPanelData('inventory');
    } catch (err) { addChatMsg('❌ Unequip failed'); }
}

async function handleInventoryClick(item) {
    if (!item) return;
    const cat = item.category || '';
    // Equipment items → equip (categories are plural in ITEMS catalog)
    const EQUIP_SLOT_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
    if (EQUIP_SLOT_MAP[cat]) {
        try {
            const res = await api('/game/equip', { method: 'POST', body: JSON.stringify({ itemId: item.item_id }) });
            if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
            addChatMsg(`✅ Equipped ${item.emoji || ''} ${item.name}!`);
            // Update local player
            const slotKey = EQUIP_SLOT_MAP[cat];
            if (myPlayer) myPlayer[slotKey] = item.item_id;
            if (cat === 'weapons') updateWeaponCooldown();
            // Add to hotbar if not already there
            assignToHotbar(item);
            loadPanelData('inventory');
        } catch (err) { addChatMsg('❌ Equip failed'); }
    // Consumables → use
    } else if (cat === 'consumable' || cat === 'potion') {
        try {
            const res = await api('/game/use', { method: 'POST', body: JSON.stringify({ itemId: item.item_id }) });
            if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
            addChatMsg(`🧪 Used ${item.emoji || ''} ${item.name}!`);
            if (res.effect) addChatMsg(`✨ ${res.effect}`);
            loadPanelData('inventory');
        } catch (err) { addChatMsg('❌ Use failed'); }
    // Food items → eat via WebSocket
    } else if (cat === 'food') {
        sendWs({ type: 'eat_food', itemId: item.item_id });
    // Fish sonar → use sonar
    } else if (item.item_id === 'fish_sonar') {
        doUseSonar();
    // Cosmetic items (name effects, particles, voices) → activate globally
    } else if (cat === 'name_effects' || cat === 'particles' || cat === 'voices') {
        // Show confirmation since this converts the game item into a global cosmetic
        addChatMsg(`🎨 ${item.emoji || ''} ${item.name} — Click again to unlock as global cosmetic`);
        if (!handleInventoryClick._pendingActivate || handleInventoryClick._pendingActivate.id !== item.item_id || Date.now() - handleInventoryClick._pendingActivate.time > 3000) {
            handleInventoryClick._pendingActivate = { id: item.item_id, time: Date.now() };
            return;
        }
        handleInventoryClick._pendingActivate = null;
        try {
            const res = await api('/game/cosmetic/activate', { method: 'POST', body: JSON.stringify({ itemId: item.item_id }) });
            if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
            addChatMsg(`✅ ${res.message || `Unlocked ${item.name} as global cosmetic!`}`);
            loadPanelData('inventory');
        } catch (err) { addChatMsg('❌ Activation failed'); }
    } else {
        addChatMsg(`${item.emoji || '📦'} ${item.name} — ${item.rarity || 'Common'} (×${item.quantity})`);
    }
}

async function npcBuyItem(itemId) {
    try {
        const res = await api('/game/npc/buy', { method: 'POST', body: JSON.stringify({ npcId: activeNPC, itemId, quantity: 1 }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        let msg = `🛒 Bought ${res.item?.emoji || ''} ${res.item?.name || itemId}!`;
        if (res.autoEquipped) msg += ' (Auto-equipped! ✅)';
        addChatMsg(msg);
        if (npcShopData) npcShopData.openvibe_coins = res.openvibe_coins;
        if (myPlayer) {
            myPlayer.openvibe_coins = res.openvibe_coins;
            // Update equip state from server response
            if (res.equip_pickaxe !== undefined) myPlayer.equip_pickaxe = res.equip_pickaxe;
            if (res.equip_axe !== undefined) myPlayer.equip_axe = res.equip_axe;
            if (res.equip_rod !== undefined) myPlayer.equip_rod = res.equip_rod;
            if (res.equip_weapon !== undefined) myPlayer.equip_weapon = res.equip_weapon;
            if (res.equip_armor !== undefined) myPlayer.equip_armor = res.equip_armor;
            if (res.equip_hat !== undefined) myPlayer.equip_hat = res.equip_hat;
        }
        // Refresh inventory data so bought items show immediately
        if (res.inventory) panelData.inventory = res.inventory;
        updateCoinDisplay();
        // Refresh NPC data
        loadNPCData(activeNPC);
    } catch (err) { addChatMsg('❌ Purchase failed'); }
}

async function npcSellItem(itemId) {
    try {
        const res = await api('/game/npc/sell', { method: 'POST', body: JSON.stringify({ npcId: activeNPC, itemId, quantity: 1 }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        addChatMsg(`💰 Sold ${res.item?.emoji || ''} ${res.item?.name || itemId} for 🪙${res.earned}!`);
        if (npcShopData) npcShopData.openvibe_coins = res.openvibe_coins;
        if (myPlayer) myPlayer.openvibe_coins = res.openvibe_coins;
        updateCoinDisplay();
        loadNPCData(activeNPC);
    } catch (err) { addChatMsg('❌ Sale failed'); }
}

async function bankAction(action, itemId) {
    try {
        const res = await api(`/game/bank/${action}`, { method: 'POST', body: JSON.stringify({ itemId, quantity: 1 }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        addChatMsg(`🏦 ${action === 'deposit' ? 'Deposited' : 'Withdrew'} item!`);
        panelData.bank = res.bank;
        panelData.inventory = res.inventory;
    } catch (err) { addChatMsg('❌ Bank action failed'); }
}

// ══════════════════════════════════════════════════════════════
//  HOTBAR SYSTEM (Minecraft-style 1-9 quick slots)
// ══════════════════════════════════════════════════════════════

function selectHotbarSlot(slotIdx) {
    if (slotIdx < 0 || slotIdx > 8) return;
    activeHotbarSlot = slotIdx;
    const slot = hotbarSlots[slotIdx];
    if (!slot) return;
    // Equippable items → auto-equip
    if (HOTBAR_EQUIP_CATS.has(slot.category)) {
        hotbarEquipItem(slot);
    }
    // Food → auto-eat
    else if (slot.category === 'food') {
        sendWs({ type: 'eat_food', itemId: slot.item_id });
    }
}

async function hotbarEquipItem(slot) {
    try {
        const res = await api('/game/equip', { method: 'POST', body: JSON.stringify({ itemId: slot.item_id }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        // Update local player equip state
        const EQUIP_MAP = { weapons: 'equip_weapon', armor: 'equip_armor', hats: 'equip_hat', pickaxes: 'equip_pickaxe', axes: 'equip_axe', rods: 'equip_rod' };
        const slotKey = EQUIP_MAP[slot.category];
        if (myPlayer && slotKey) myPlayer[slotKey] = slot.item_id;
        if (slot.category === 'weapons') updateWeaponCooldown();
    } catch (err) { addChatMsg('❌ Equip failed'); }
}

function refreshHotbarFromInventory() {
    const inv = panelData.inventory;
    if (!inv) return;
    // Auto-populate empty hotbar slots with equippable/food items from inventory
    // Preserve existing valid assignments; remove items no longer in inventory
    for (let i = 0; i < 9; i++) {
        const slot = hotbarSlots[i];
        if (slot) {
            // Verify item still in inventory
            const found = inv.find(it => it.item_id === slot.item_id && (it.quantity || 0) > 0);
            if (!found) hotbarSlots[i] = null;
        }
    }
    // Fill empty slots with un-assigned equippable items (tools first, then weapons, then food)
    const assigned = new Set(hotbarSlots.filter(Boolean).map(s => s.item_id));
    const priorityOrder = ['pickaxes', 'axes', 'rods', 'weapons', 'food', 'armor', 'hats', 'consumable', 'potion'];
    const candidates = inv.filter(it => HOTBAR_VALID_CATS.has(it.category) && !assigned.has(it.item_id));
    candidates.sort((a, b) => priorityOrder.indexOf(a.category) - priorityOrder.indexOf(b.category));
    for (const item of candidates) {
        const emptyIdx = hotbarSlots.indexOf(null);
        if (emptyIdx === -1) break;
        hotbarSlots[emptyIdx] = { item_id: item.item_id, name: item.name, emoji: item.emoji || '❓', category: item.category };
    }
}

function assignToHotbar(item) {
    // If already in hotbar, don't duplicate
    if (hotbarSlots.some(s => s && s.item_id === item.item_id)) return;
    const emptyIdx = hotbarSlots.indexOf(null);
    if (emptyIdx === -1) return; // hotbar full
    hotbarSlots[emptyIdx] = { item_id: item.item_id, name: item.name, emoji: item.emoji || '❓', category: item.category };
}

function removeFromHotbar(itemId) {
    for (let i = 0; i < 9; i++) {
        if (hotbarSlots[i] && hotbarSlots[i].item_id === itemId) {
            hotbarSlots[i] = null;
            break;
        }
    }
}

function drawHotbar(ctx) {
    const SLOT_SIZE = 42;
    const GAP = 4;
    const SLOTS = 9;
    const totalW = SLOTS * SLOT_SIZE + (SLOTS - 1) * GAP;
    const startX = (CAM_W - totalW) / 2;
    const startY = CAM_H - SLOT_SIZE - 30;
    const R = 5; // corner radius

    // Backdrop behind all slots
    const bdPad = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    const bx = startX - bdPad, by = startY - bdPad, bw = totalW + bdPad * 2, bh = SLOT_SIZE + bdPad * 2;
    ctx.moveTo(bx + R, by); ctx.lineTo(bx + bw - R, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + R, R); ctx.lineTo(bx + bw, by + bh - R);
    ctx.arcTo(bx + bw, by + bh, bx + bw - R, by + bh, R); ctx.lineTo(bx + R, by + bh);
    ctx.arcTo(bx, by + bh, bx, by + bh - R, R); ctx.lineTo(bx, by + R);
    ctx.arcTo(bx, by, bx + R, by, R); ctx.closePath();
    ctx.fill();

    for (let i = 0; i < SLOTS; i++) {
        const sx = startX + i * (SLOT_SIZE + GAP);
        const slot = hotbarSlots[i];
        const isActive = (i === activeHotbarSlot);

        // Rounded slot
        ctx.beginPath();
        ctx.moveTo(sx + R, startY); ctx.lineTo(sx + SLOT_SIZE - R, startY);
        ctx.arcTo(sx + SLOT_SIZE, startY, sx + SLOT_SIZE, startY + R, R);
        ctx.lineTo(sx + SLOT_SIZE, startY + SLOT_SIZE - R);
        ctx.arcTo(sx + SLOT_SIZE, startY + SLOT_SIZE, sx + SLOT_SIZE - R, startY + SLOT_SIZE, R);
        ctx.lineTo(sx + R, startY + SLOT_SIZE);
        ctx.arcTo(sx, startY + SLOT_SIZE, sx, startY + SLOT_SIZE - R, R);
        ctx.lineTo(sx, startY + R);
        ctx.arcTo(sx, startY, sx + R, startY, R);
        ctx.closePath();

        ctx.fillStyle = isActive ? 'rgba(255,255,255,0.18)' : 'rgba(15,15,25,0.7)';
        ctx.fill();

        if (isActive) {
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 6;
        }
        ctx.strokeStyle = isActive ? '#fbbf24' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Item emoji
        if (slot) {
            ctx.font = '20px serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#fff';
            ctx.fillText(slot.emoji, sx + SLOT_SIZE / 2, startY + 27);
        }

        // Slot number (top-left)
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = isActive ? '#fbbf24' : 'rgba(255,255,255,0.4)';
        ctx.fillText(`${i + 1}`, sx + 3, startY + 10);
    }

    // Active slot name label (pill badge above)
    const activeItem = hotbarSlots[activeHotbarSlot];
    if (activeItem) {
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        const nameW = ctx.measureText(activeItem.name).width + 12;
        const nameX = CAM_W / 2 - nameW / 2, nameY = startY - 10;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.moveTo(nameX + 4, nameY); ctx.lineTo(nameX + nameW - 4, nameY);
        ctx.arcTo(nameX + nameW, nameY, nameX + nameW, nameY + 4, 4);
        ctx.lineTo(nameX + nameW, nameY + 14); ctx.arcTo(nameX + nameW, nameY + 18, nameX + nameW - 4, nameY + 18, 4);
        ctx.lineTo(nameX + 4, nameY + 18); ctx.arcTo(nameX, nameY + 18, nameX, nameY + 14, 4);
        ctx.lineTo(nameX, nameY + 4); ctx.arcTo(nameX, nameY, nameX + 4, nameY, 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(activeItem.name, CAM_W / 2, nameY + 13);
    }
}

function doGather() {
    if (!myPlayer || Date.now() - lastGatherTime < 1000) return;
    const tx = Math.floor(myPlayer.x / TILE);
    const ty = Math.floor(myPlayer.y / TILE);
    // Check nearby tiles for a resource node
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cx = tx + dx, cy = ty + dy;
            const node = getResourceNodeAt(cx, cy, worldSeed);
            if (node && !depletedNodes.has(`${cx},${cy}`)) {
                // Immediate swing animation on gather attempt
                swingAnim = 1;
                swingType = node.type === 'rock' ? 'mine' : node.type === 'tree' ? 'chop' : 'punch';
                sendWs({ type: 'gather', tileX: cx, tileY: cy });
                return;
            }
        }
    }
    addChatMsg('Nothing to gather nearby. Click on a resource node!');
}

function doPickup() {
    if (!myPlayer) return;
    // Find nearest ground item within pickup range
    let nearest = null, nearDist = Infinity;
    for (const [gid, gi] of Object.entries(groundItems)) {
        const dist = Math.sqrt((gi.x - myPlayer.x) ** 2 + (gi.y - myPlayer.y) ** 2);
        if (dist < TILE * 2.5 && dist < nearDist) {
            nearest = parseInt(gid);
            nearDist = dist;
        }
    }
    if (nearest !== null) {
        sendWs({ type: 'pickup', groundItemId: nearest });
    } else {
        addChatMsg('Nothing to pick up nearby.');
    }
}

function doFish(targetTileX, targetTileY) {
    if (!myPlayer || Date.now() - lastFishTime < 1500) return;
    if (!myPlayer.equip_rod) { addChatMsg('🎣 Equip a fishing rod first!'); return; }
    // Enter fishing mode instead of instant catch
    enterFishingMode(targetTileX, targetTileY);
}

// ══════════════════════════════════════════════════════════════
//  FISHING MINI-GAME (Toontown-style)
// ══════════════════════════════════════════════════════════════

function enterFishingMode(tileX, tileY) {
    if (FISHING.active) return;
    if (!myPlayer?.equip_rod) { addChatMsg('🎣 Equip a fishing rod first!'); return; }

    // Determine zone for display
    const zone = getWaterZone(tileX, tileY, worldSeed);

    FISHING.active = true;
    FISHING.phase = 'targeting';
    FISHING.tileX = tileX;
    FISHING.tileY = tileY;
    FISHING.zone = zone;
    FISHING.castAnim = 0;
    FISHING.castHit = false;
    FISHING.reelRound = 0;
    FISHING.reelScore = 0;
    FISHING.reelClicked = false;
    FISHING.reelResultTimer = 0;
    FISHING.resultTimer = 0;
    FISHING.resultData = null;

    // Pond overlay rect (centered on screen)
    const pw = 400, ph = 300;
    FISHING.pondRect = { x: (CAM_W - pw) / 2, y: (CAM_H - ph) / 2 - 30, w: pw, h: ph };
    FISHING.cursorX = pw / 2;
    FISHING.cursorY = ph / 2;

    // Spawn fish shadows (3-5 depending on zone richness)
    const shadowCounts = { shallow: 3, river: 4, deep: 5, arctic: 4 };
    FISHING.shadowCount = shadowCounts[zone] || 3;
    FISHING.shadows = [];
    for (let i = 0; i < FISHING.shadowCount; i++) {
        const bx = 60 + Math.random() * (pw - 120);
        const by = 60 + Math.random() * (ph - 120);
        FISHING.shadows.push({
            x: bx, y: by, baseX: bx, baseY: by,
            angle: Math.random() * Math.PI * 2,
            speed: 0.008 + Math.random() * 0.012,
            radius: 25 + Math.random() * 35,
            size: 14 + Math.random() * 10,
        });
    }

    activePanel = null; // Close any open panel
    addChatMsg(`🎣 Fishing in ${zone} waters... Click on a fish shadow to cast!`);
}

function exitFishingMode() {
    FISHING.active = false;
    FISHING.phase = 'idle';
    FISHING.shadows = [];
}

function handleFishingClick() {
    const F = FISHING;
    const pr = F.pondRect;

    if (F.phase === 'targeting') {
        // Check if cursor is inside pond
        const cx = mouseX - pr.x;
        const cy = mouseY - pr.y;
        if (cx < 0 || cy < 0 || cx > pr.w || cy > pr.h) return;

        // Cast toward click position
        F.castX = cx;
        F.castY = cy;
        F.castAnim = 0;
        F.castHit = false;
        F.phase = 'casting';

        // Check if cast lands near a shadow
        for (const sh of F.shadows) {
            const dx = sh.x - cx, dy = sh.y - cy;
            if (Math.sqrt(dx * dx + dy * dy) < sh.size + 12) {
                F.castHit = true;
                break;
            }
        }
    } else if (F.phase === 'reeling' && !F.reelClicked) {
        // Click during reel to try to hit sweet spot
        F.reelClicked = true;
        const inSweet = Math.abs(F.reelBarPos - F.reelSweetSpot) <= F.reelSweetWidth / 2;
        if (inSweet) {
            F.reelScore++;
            F.reelRoundResult = 'hit';
        } else {
            F.reelRoundResult = 'miss';
        }
        F.reelResultTimer = 40; // frames to show result before next round
    } else if (F.phase === 'result') {
        // Click to dismiss result
        exitFishingMode();
    }
}

function updateFishing() {
    if (!FISHING.active) return;
    const F = FISHING;
    const pr = F.pondRect;

    if (F.phase === 'targeting') {
        // Animate shadows — swim in elliptical paths
        for (const sh of F.shadows) {
            sh.angle += sh.speed;
            sh.x = sh.baseX + Math.cos(sh.angle) * sh.radius * 0.6;
            sh.y = sh.baseY + Math.sin(sh.angle * 0.7) * sh.radius * 0.4;
            // Keep in bounds
            sh.x = Math.max(20, Math.min(pr.w - 20, sh.x));
            sh.y = Math.max(20, Math.min(pr.h - 20, sh.y));
        }
        // Track cursor to mouse position (relative to pond)
        F.cursorX = mouseX - pr.x;
        F.cursorY = mouseY - pr.y;
    } else if (F.phase === 'casting') {
        F.castAnim += 0.06;
        if (F.castAnim >= 1) {
            F.castAnim = 1;
            if (F.castHit) {
                // Transition to reeling
                F.phase = 'reeling';
                F.reelRound = 0;
                F.reelScore = 0;
                F.reelBarPos = 0;
                F.reelBarDir = 1;
                F.reelClicked = false;
                F.reelResultTimer = 0;
                F.reelRoundResult = '';
                // Sweet spot randomized each round, speed based on zone difficulty
                const zoneSpeed = { shallow: 0.012, river: 0.016, deep: 0.022, arctic: 0.02 };
                F.reelBarSpeed = zoneSpeed[F.zone] || 0.016;
                F.reelSweetSpot = 0.3 + Math.random() * 0.4;
                F.reelSweetWidth = 0.28;
                addChatMsg('🎣 Fish on! Click when the bar is in the green zone!');
            } else {
                // Missed — brief result then exit
                F.phase = 'result';
                F.resultTimer = 90;
                F.resultData = { escaped: true, message: 'Nothing bit... Try aiming at the shadows!' };
                // Still costs stamina — send to server with reelScore 0
                sendWs({ type: 'fish', tileX: F.tileX, tileY: F.tileY, reelScore: 0 });
                lastFishTime = Date.now();
            }
        }
    } else if (F.phase === 'reeling') {
        if (F.reelResultTimer > 0) {
            F.reelResultTimer--;
            if (F.reelResultTimer <= 0) {
                F.reelRound++;
                if (F.reelRound >= 3) {
                    // Done reeling — send result to server
                    F.phase = 'result';
                    F.resultTimer = 150;
                    sendWs({ type: 'fish', tileX: F.tileX, tileY: F.tileY, reelScore: F.reelScore });
                    lastFishTime = Date.now();
                } else {
                    // Next round — harder
                    F.reelClicked = false;
                    F.reelRoundResult = '';
                    F.reelBarSpeed += 0.005;
                    F.reelSweetSpot = 0.25 + Math.random() * 0.5;
                    F.reelSweetWidth = Math.max(0.15, F.reelSweetWidth - 0.04);
                }
            }
        } else {
            // Oscillate the bar
            F.reelBarPos += F.reelBarSpeed * F.reelBarDir;
            if (F.reelBarPos >= 1) { F.reelBarPos = 1; F.reelBarDir = -1; }
            if (F.reelBarPos <= 0) { F.reelBarPos = 0; F.reelBarDir = 1; }

            // Auto-fail if player doesn't click for too long (2 seconds worth of frames)
            if (!F.reelClicked && !F._reelAutoTimer) F._reelAutoTimer = 120;
            if (!F.reelClicked) {
                F._reelAutoTimer--;
                if (F._reelAutoTimer <= 0) {
                    F.reelClicked = true;
                    F.reelRoundResult = 'miss';
                    F.reelResultTimer = 30;
                    F._reelAutoTimer = 0;
                }
            } else {
                F._reelAutoTimer = 0;
            }
        }
    } else if (F.phase === 'result') {
        F.resultTimer--;
        if (F.resultTimer <= 0 && F.resultData) {
            exitFishingMode();
        }
    }
}

function renderFishingOverlay(ctx) {
    const F = FISHING;
    const pr = F.pondRect;

    // Darken background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, CAM_W, CAM_H);

    // Title
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    const zoneNames = { shallow: '🏖️ Shallow Waters', river: '🏞️ River', deep: '🌊 Deep Ocean', arctic: '❄️ Arctic Waters' };
    ctx.fillText(zoneNames[F.zone] || 'Fishing', CAM_W / 2, pr.y - 20);

    ctx.font = '12px monospace';
    ctx.fillStyle = '#999';
    ctx.fillText('Press ESC to cancel', CAM_W / 2, pr.y - 6);

    // ── Pond View ─────────────────────────────────
    // Water background with subtle animation
    const t = Date.now() / 1000;
    const waterGrad = ctx.createLinearGradient(pr.x, pr.y, pr.x, pr.y + pr.h);
    waterGrad.addColorStop(0, '#0a3058');
    waterGrad.addColorStop(0.5, '#0d4a7a');
    waterGrad.addColorStop(1, '#082040');
    ctx.fillStyle = waterGrad;
    roundRect(ctx, pr.x, pr.y, pr.w, pr.h, 12);
    ctx.fill();

    // Water ripple lines
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
        const ry = pr.y + 30 + i * 45 + Math.sin(t * 0.8 + i) * 8;
        ctx.beginPath();
        ctx.moveTo(pr.x + 10, ry);
        for (let x = 0; x < pr.w - 20; x += 20) {
            ctx.lineTo(pr.x + 10 + x + 10, ry + Math.sin(t * 1.2 + x * 0.05 + i) * 4);
        }
        ctx.stroke();
    }

    // Pond border
    ctx.strokeStyle = '#2a6090';
    ctx.lineWidth = 2;
    roundRect(ctx, pr.x, pr.y, pr.w, pr.h, 12);
    ctx.stroke();

    if (F.phase === 'targeting') {
        // Draw fish shadows
        for (const sh of F.shadows) {
            const sx = pr.x + sh.x, sy = pr.y + sh.y;
            // Shadow (dark ellipse)
            ctx.fillStyle = 'rgba(0, 20, 50, 0.5)';
            ctx.beginPath();
            ctx.ellipse(sx, sy, sh.size, sh.size * 0.6, sh.angle * 0.3, 0, Math.PI * 2);
            ctx.fill();
            // Subtle tail flick
            const tailX = sx - Math.cos(sh.angle) * sh.size * 0.8;
            const tailY = sy - Math.sin(sh.angle * 0.7) * sh.size * 0.3;
            ctx.fillStyle = 'rgba(0, 20, 50, 0.3)';
            ctx.beginPath();
            ctx.ellipse(tailX, tailY, sh.size * 0.4, sh.size * 0.25, sh.angle * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw aim cursor (crosshair)
        const ax = pr.x + F.cursorX, ay = pr.y + F.cursorY;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ax, ay, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ax - 18, ay); ctx.lineTo(ax - 6, ay);
        ctx.moveTo(ax + 6, ay); ctx.lineTo(ax + 18, ay);
        ctx.moveTo(ax, ay - 18); ctx.lineTo(ax, ay - 6);
        ctx.moveTo(ax, ay + 6); ctx.lineTo(ax, ay + 18);
        ctx.stroke();

        // Instruction
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('🎯 Click on a fish shadow to cast!', CAM_W / 2, pr.y + pr.h + 25);

    } else if (F.phase === 'casting') {
        // Draw cast line animation
        const startX = pr.x + pr.w / 2, startY = pr.y + pr.h + 10;
        const endX = pr.x + F.castX, endY = pr.y + F.castY;
        const progress = F.castAnim;
        const curX = startX + (endX - startX) * progress;
        const curY = startY + (endY - startY) * progress;
        // Arc trajectory
        const arcY = curY - Math.sin(progress * Math.PI) * 60;

        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        // Draw line up to current position
        for (let p = 0; p <= progress; p += 0.05) {
            const lx = startX + (endX - startX) * p;
            const ly = startY + (endY - startY) * p - Math.sin(p * Math.PI) * 60;
            ctx.lineTo(lx, ly);
        }
        ctx.stroke();

        // Bobber at end
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(curX, arcY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(curX, arcY - 3, 3, 0, Math.PI * 2);
        ctx.fill();

        // Splash on landing
        if (progress > 0.9) {
            ctx.font = '20px serif';
            ctx.textAlign = 'center';
            ctx.fillText('💦', pr.x + F.castX, pr.y + F.castY);
        }

    } else if (F.phase === 'reeling') {
        renderReelBar(ctx);

    } else if (F.phase === 'result') {
        renderFishResult(ctx);
    }
}

function renderReelBar(ctx) {
    const F = FISHING;
    const barW = 350, barH = 30;
    const barX = (CAM_W - barW) / 2;
    const barY = CAM_H / 2 + 60;

    // Round info
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`🎣 REEL IT IN! Round ${F.reelRound + 1}/3`, CAM_W / 2, barY - 50);

    // Score dots
    for (let i = 0; i < 3; i++) {
        const dotX = CAM_W / 2 - 30 + i * 30;
        const dotY = barY - 30;
        ctx.fillStyle = i < F.reelScore ? '#22c55e' : (i === F.reelRound && F.reelRoundResult === 'miss' ? '#ef4444' : '#555');
        ctx.beginPath();
        ctx.arc(dotX, dotY, 8, 0, Math.PI * 2);
        ctx.fill();
        if (i < F.reelScore) {
            ctx.fillStyle = '#fff';
            ctx.font = '10px monospace';
            ctx.fillText('✓', dotX, dotY + 3);
        }
    }

    // Bar background
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, barX, barY, barW, barH, 6);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    roundRect(ctx, barX, barY, barW, barH, 6);
    ctx.stroke();

    // Sweet spot (green zone)
    const sweetLeft = barX + (F.reelSweetSpot - F.reelSweetWidth / 2) * barW;
    const sweetW = F.reelSweetWidth * barW;
    ctx.fillStyle = 'rgba(34, 197, 94, 0.35)';
    ctx.fillRect(sweetLeft, barY + 2, sweetW, barH - 4);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sweetLeft, barY + 2, sweetW, barH - 4);

    // Danger zones (red edges)
    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    ctx.fillRect(barX + 2, barY + 2, sweetLeft - barX - 2, barH - 4);
    ctx.fillRect(sweetLeft + sweetW, barY + 2, barX + barW - sweetLeft - sweetW - 2, barH - 4);

    // Oscillating indicator
    if (F.reelResultTimer <= 0) {
        const indX = barX + F.reelBarPos * barW;
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        // Triangle pointer
        ctx.moveTo(indX, barY - 4);
        ctx.lineTo(indX - 6, barY - 12);
        ctx.lineTo(indX + 6, barY - 12);
        ctx.closePath();
        ctx.fill();
        // Line
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(indX, barY + 2);
        ctx.lineTo(indX, barY + barH - 2);
        ctx.stroke();
    }

    // Round result flash
    if (F.reelResultTimer > 0 && F.reelRoundResult) {
        ctx.font = 'bold 28px monospace';
        ctx.textAlign = 'center';
        if (F.reelRoundResult === 'hit') {
            ctx.fillStyle = '#22c55e';
            ctx.fillText('✓ NICE!', CAM_W / 2, barY + barH + 35);
        } else {
            ctx.fillStyle = '#ef4444';
            ctx.fillText('✗ MISS', CAM_W / 2, barY + barH + 35);
        }
    }

    // Instruction
    ctx.fillStyle = '#999';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Click when the pointer is in the green zone!', CAM_W / 2, barY + barH + 55);
}

function renderFishResult(ctx) {
    const F = FISHING;
    const data = F.resultData;
    if (!data) return;

    const cx = CAM_W / 2, cy = CAM_H / 2;

    if (data.escaped) {
        // Miss result
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(data.message || 'The fish got away!', cx, cy - 10);
        ctx.font = '14px monospace';
        ctx.fillStyle = '#999';
        ctx.fillText('Click or wait to continue...', cx, cy + 20);
    } else if (data.success && data.loot) {
        const loot = data.loot;
        const rarCol = RARITY_COLORS[loot.rarity] || '#fff';

        // Big fish emoji
        ctx.font = '48px serif';
        ctx.textAlign = 'center';
        ctx.fillText(loot.emoji || '🐟', cx, cy - 60);

        // Fish name + rarity
        ctx.fillStyle = rarCol;
        ctx.font = 'bold 20px monospace';
        ctx.fillText(`${loot.name}`, cx, cy - 15);

        // Weight
        if (loot.weight > 0) {
            ctx.fillStyle = '#fbbf24';
            ctx.font = '16px monospace';
            ctx.fillText(`${loot.weight} lbs`, cx, cy + 10);
        }

        // Rarity label
        ctx.fillStyle = rarCol;
        ctx.font = '13px monospace';
        ctx.fillText(`[${loot.rarity}]`, cx, cy + 30);

        // Reel quality
        const qualLabels = { 1: '⭐', 2: '⭐⭐', 3: '⭐⭐⭐ PERFECT!' };
        if (data.reelScore) {
            ctx.fillStyle = data.reelScore === 3 ? '#fbbf24' : '#aaa';
            ctx.font = '14px monospace';
            ctx.fillText(qualLabels[data.reelScore] || '', cx, cy + 50);
        }

        // New species discovery!
        if (data.newSpecies) {
            ctx.fillStyle = '#22c55e';
            ctx.font = 'bold 16px monospace';
            ctx.fillText('🆕 NEW SPECIES DISCOVERED!', cx, cy + 75);
        }

        // Milestone
        if (data.milestone) {
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold 14px monospace';
            ctx.fillText(`🏆 TROPHY! ${data.milestone.threshold} species! +${data.milestone.hpBoost} Max HP`, cx, cy + 95);
        }

        // XP
        if (data.xp?.gained) {
            ctx.fillStyle = '#3b82f6';
            ctx.font = '13px monospace';
            ctx.fillText(`+${data.xp.totalXp} Fishing XP`, cx, cy + 115);
        }

        ctx.fillStyle = '#666';
        ctx.font = '11px monospace';
        ctx.fillText('Click to continue', cx, cy + 140);
    }
}

// Helper: rounded rectangle path
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function handleFishResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); exitFishingMode(); return; }
    if (!msg.success) return;

    // If fishing overlay is active, show result there
    if (FISHING.active && FISHING.phase === 'result') {
        FISHING.resultData = msg;
        FISHING.resultTimer = 200; // longer display for catches
    }

    if (msg.escaped) {
        if (!FISHING.active) addChatMsg('🎣 The fish got away!');
        return;
    }

    refreshDailyQuests();

    const loot = msg.loot;
    const rarCol = RARITY_COLORS[loot.rarity] || '#fff';
    const zoneName = { shallow: '🏖️ Shallow', river: '🏞️ River', deep: '🌊 Deep', arctic: '❄️ Arctic' }[msg.zone] || msg.zone;
    const weightStr = loot.weight > 0 ? ` (${loot.weight} lbs)` : '';
    addChatMsg(`🎣 Caught ${loot.emoji || '🐟'} ${loot.name}${weightStr} [${loot.rarity}] in ${zoneName}!`);

    if (msg.newSpecies) addChatMsg('🆕 New species for your Fish Album!');
    if (msg.milestone) addChatMsg(`🏆 Trophy! ${msg.milestone.threshold} species caught! +${msg.milestone.hpBoost} Max HP!`);

    addFloatingText(myPlayer.x, myPlayer.y - 20, `+${loot.emoji || '🐟'} ${loot.name}`, rarCol);
    if (msg.xp?.totalXp) addFloatingText(myPlayer.x + 20, myPlayer.y - 10, `+${msg.xp.totalXp} XP`, '#3b82f6');

    // Splash particles
    for (let i = 0; i < 4; i++) {
        const angle = (Math.PI * 2 / 4) * i;
        addFloatingText(
            myPlayer.x + Math.cos(angle) * 14,
            myPlayer.y + Math.sin(angle) * 14 - 8,
            '💧', '#3b82f6'
        );
    }
    if (['Rare', 'Epic', 'Legendary', 'Mythic'].includes(loot.rarity)) {
        const canvas = document.getElementById('gameCanvas');
        if (canvas) { canvas.classList.add('gather-flash'); setTimeout(() => canvas.classList.remove('gather-flash'), 300); }
    }
    if (msg.xp?.leveledUp) {
        addChatMsg(`🎉 Fishing level up! Now level ${msg.xp.newLevel}`);
        addFloatingText(myPlayer.x, myPlayer.y - 40, `⬆️ FISHING ${msg.xp.newLevel}!`, '#fbbf24');
    }
    if (msg.toolBroke) addChatMsg(`💥 Your ${msg.toolBroke} broke!`);
    if (msg.stamina !== undefined) myPlayer.stamina = msg.stamina;
}

function handleFishEffect(msg) {
    const wx = msg.tileX * TILE + TILE / 2;
    const wy = msg.tileY * TILE + TILE / 2;
    addFloatingText(wx, wy, '🎣', '#fff');
}

async function doUseSonar() {
    if (!myPlayer) return;
    const tx = Math.floor(myPlayer.x / TILE);
    const ty = Math.floor(myPlayer.y / TILE);
    try {
        const res = await api('/game/use-sonar', { method: 'POST', body: JSON.stringify({ tileX: tx, tileY: ty }) });
        if (res.error) { addChatMsg(`❌ ${res.error}`); return; }
        if (res.zones && res.zones.length) {
            sonarOverlay = { zones: res.zones, expiresAt: Date.now() + 10000 };
            addChatMsg('📡 Sonar activated! Fish detected:');
            for (const z of res.zones) {
                const topFish = z.fish.slice(0, 4).map(f => `${f.emoji} ${f.name}`).join(', ');
                addChatMsg(`  ${z.zone.toUpperCase()}: ${topFish}`);
            }
        } else {
            addChatMsg('📡 No water nearby!');
        }
        loadPanelData('inventory');
    } catch { addChatMsg('❌ Sonar failed'); }
}

// ══════════════════════════════════════════════════════════════
//  DODGE / FOOD / COMBO HANDLERS
// ══════════════════════════════════════════════════════════════

function handleDodgeResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        dodgeCooldownUntil = Date.now() + 1000; // 1s cooldown
        dodgeFlashTimer = 300; // white flash for 300ms
        dodgeAnimTimer = 300;
        dodgeAnimDx = msg.dx || 0;
        dodgeAnimDy = msg.dy || 0;
        if (msg.newX != null && msg.newY != null && myPlayer) {
            myPlayer.x = msg.newX;
            myPlayer.y = msg.newY;
        }
        if (msg.stamina != null && myPlayer) myPlayer.stamina = msg.stamina;
        addFloatingText(myPlayer.x, myPlayer.y - 30, '💨 DODGE!', '#60a5fa');
        // Agility XP from dodging
        if (msg.agilityXp) {
            addFloatingText(myPlayer.x + 20, myPlayer.y - 45, `+${msg.agilityXp.totalXp} 🏃 AGI`, '#22d3ee');
            if (myPlayer) {
                myPlayer.agility_xp = msg.agilityXp.xp;
                myPlayer.agility_level = msg.agilityXp.newLevel;
            }
            if (msg.agilityXp.leveledUp) {
                addChatMsg(`🏃 Agility leveled up to ${msg.agilityXp.newLevel}!`);
                // Recalculate bonuses client-side
                const lv = msg.agilityXp.newLevel;
                agilityBonuses = {
                    maxStaminaBonus: lv * 2,
                    regenBonus: Math.floor(lv * 0.4),
                    sprintDrainMult: Math.max(0.50, 1.0 - lv * 0.02),
                    dodgeCostReduct: Math.min(10, Math.floor(lv * 0.5)),
                    swimSpeedMult: 1.0 + lv * 0.02,
                    sprintSpeedMult: 1.0 + Math.floor(lv / 5) * 0.02,
                };
                if (myPlayer) myPlayer.max_stamina = 100 + agilityBonuses.maxStaminaBonus;
            }
        }
    }
}

function handleEatFoodResult(msg) {
    if (msg.error) { addChatMsg(`❌ ${msg.error}`); return; }
    if (msg.success) {
        addChatMsg(`🍽️ ${msg.message || 'Ate food!'}`);
        if (msg.hp != null && myPlayer) myPlayer.hp = msg.hp;
        if (msg.stamina != null && myPlayer) myPlayer.stamina = msg.stamina;
        if (msg.buff) {
            activeFoodBuff = {
                name: msg.buff.name || 'Food Buff',
                expiresAt: Date.now() + (msg.buff.duration || 60000),
                effects: msg.buff,
            };
        }
        loadPanelData('inventory'); // Refresh inventory after eating
    }
}

function updateWeaponCooldown(speed) {
    if (speed) {
        attackCooldown = Math.round(BASE_ATTACK_COOLDOWN / speed);
    } else if (myPlayer) {
        const wepId = myPlayer.equip_weapon || 'weapon_fist';
        const wepInfo = serverWeaponStats[wepId] || serverWeaponStats['weapon_fist'] || {};
        attackCooldown = Math.round(BASE_ATTACK_COOLDOWN / (wepInfo.speed || 1.0));
    }
}

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET SEND
// ══════════════════════════════════════════════════════════════

function sendWs(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 256 * 1024) return;
        ws.send(JSON.stringify(data));
    }
}

// ══════════════════════════════════════════════════════════════
//  COINS DISPLAY
// ══════════════════════════════════════════════════════════════

function updateCoinDisplay() {
    // Sync with platform header coin display (game-coins element removed — coins shown in inventory panel now)
    const platformCoins = document.getElementById('nav-coins-amount');
    if (platformCoins && myPlayer) platformCoins.textContent = myPlayer.openvibe_coins || 0;
}

// Refresh coins from server (call after transactions)
async function refreshCoins() {
    try {
        const data = await api('/game/player');
        if (data.success && data.player) {
            myPlayer.openvibe_coins = data.player.openvibe_coins;
            updateCoinDisplay();
        }
    } catch {}
}

// ══════════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════════

setupGameInput();
