-- ═══════════════════════════════════════════════════════════════
-- OpenVibeGame — Rust-Style Survival Game Schema
-- Procedural world, base building, gathering, PvP, economy
-- ═══════════════════════════════════════════════════════════════

-- World state (seed, config)
CREATE TABLE IF NOT EXISTS game_world_state (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Player profile (1:1 with users)
CREATE TABLE IF NOT EXISTS game_players (
    user_id INTEGER PRIMARY KEY,
    display_name TEXT,
    x REAL DEFAULT 4096,
    y REAL DEFAULT 4096,
    -- XP
    mining_xp INTEGER DEFAULT 0,
    fishing_xp INTEGER DEFAULT 0,
    woodcut_xp INTEGER DEFAULT 0,
    farming_xp INTEGER DEFAULT 0,
    combat_xp INTEGER DEFAULT 0,
    crafting_xp INTEGER DEFAULT 0,
    agility_xp INTEGER DEFAULT 0,
    -- Combat
    hp INTEGER DEFAULT 100,
    max_hp INTEGER DEFAULT 100,
    attack INTEGER DEFAULT 10,
    defense INTEGER DEFAULT 5,
    -- Stamina
    stamina INTEGER DEFAULT 100,
    max_stamina INTEGER DEFAULT 100,
    last_stamina_tick DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Equipment slots (NULL = bare hands / no tool)
    equip_pickaxe TEXT DEFAULT NULL,
    equip_rod TEXT DEFAULT NULL,
    equip_axe TEXT DEFAULT NULL,
    equip_hat TEXT,
    equip_weapon TEXT,
    equip_armor TEXT,
    -- Spawn point (sleeping bag)
    sleeping_bag_x REAL,
    sleeping_bag_y REAL,
    -- Appearance
    sprite_skin INTEGER DEFAULT 0,
    name_effect TEXT,
    particle_effect TEXT,
    chat_color TEXT DEFAULT '#e8e6e3',
    -- Stats
    total_coins_earned INTEGER DEFAULT 0,
    total_items_crafted INTEGER DEFAULT 0,
    total_monsters_killed INTEGER DEFAULT 0,
    total_deaths INTEGER DEFAULT 0,
    battle_wins INTEGER DEFAULT 0,
    battle_losses INTEGER DEFAULT 0,
    structures_built INTEGER DEFAULT 0,
    resources_gathered INTEGER DEFAULT 0,
    -- Timestamps
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_action DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Inventory
CREATE TABLE IF NOT EXISTS game_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    UNIQUE(user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ginv_user ON game_inventory(user_id);

-- Bank storage (safe, no drop on death)
CREATE TABLE IF NOT EXISTS game_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    UNIQUE(user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Structures (buildings in the world)
CREATE TABLE IF NOT EXISTS game_structures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    hp INTEGER DEFAULT 100,
    max_hp INTEGER DEFAULT 100,
    data TEXT DEFAULT '{}',
    built_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tile_x, tile_y),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_struct_tile ON game_structures(tile_x, tile_y);
CREATE INDEX IF NOT EXISTS idx_struct_owner ON game_structures(owner_id);

-- Farm plots (tile-based in game world)
CREATE TABLE IF NOT EXISTS game_farm_plots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plot_index INTEGER DEFAULT 0,
    crop_id TEXT,
    planted_at DATETIME,
    watered_at DATETIME,
    fertilized INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'empty' CHECK(stage IN ('empty','seed','sprout','growing','ripe','withered')),
    UNIQUE(user_id, plot_index),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Unlocked recipes
CREATE TABLE IF NOT EXISTS game_recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    recipe_id TEXT NOT NULL,
    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, recipe_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Active effects (buffs, cosmetics)
CREATE TABLE IF NOT EXISTS game_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    effect_type TEXT NOT NULL,
    effect_id TEXT,
    expires_at DATETIME,
    charges INTEGER,
    data TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geffects_user ON game_effects(user_id);

-- Battle stats
CREATE TABLE IF NOT EXISTS game_battle_stats (
    user_id INTEGER PRIMARY KEY,
    battles_won INTEGER DEFAULT 0,
    battles_lost INTEGER DEFAULT 0,
    total_stolen INTEGER DEFAULT 0,
    total_lost INTEGER DEFAULT 0,
    kill_streak INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Dungeon runs
CREATE TABLE IF NOT EXISTS game_dungeon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leader_id INTEGER NOT NULL,
    floor_reached INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','failed','abandoned')),
    party_data TEXT DEFAULT '[]',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (leader_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Leaderboard cache
CREATE TABLE IF NOT EXISTS game_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    board_type TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    rank INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, board_type),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Fish collection (Toontown-style album)
CREATE TABLE IF NOT EXISTS game_fish_collection (
    user_id INTEGER NOT NULL,
    fish_id TEXT NOT NULL,
    times_caught INTEGER DEFAULT 1,
    max_weight REAL DEFAULT 0,
    first_caught DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, fish_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fish_coll_user ON game_fish_collection(user_id);

-- Daily quest progress and claims
CREATE TABLE IF NOT EXISTS game_daily_quest_progress (
    user_id INTEGER NOT NULL,
    quest_date TEXT NOT NULL,
    stat_key TEXT NOT NULL,
    value REAL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, quest_date, stat_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_quest_progress_user_date ON game_daily_quest_progress(user_id, quest_date);

CREATE TABLE IF NOT EXISTS game_daily_quest_claims (
    user_id INTEGER NOT NULL,
    quest_date TEXT NOT NULL,
    quest_id TEXT NOT NULL,
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, quest_date, quest_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_quest_claims_user_date ON game_daily_quest_claims(user_id, quest_date);
