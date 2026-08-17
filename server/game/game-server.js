/**
 * OpenVibeGame — WebSocket Game Server
 * Single continuous world: movement, gathering, building, PvP, chat
 */

const { WebSocketServer, WebSocket } = require('ws');
const db = require('../db/database');
const game = require('./game-engine');
const cosmetics = require('../monetization/cosmetics');
const { resolveGameIdentity, getRequestIp } = require('./game-auth');
const TICK_RATE = 100; // ms (10 Hz)
const HEARTBEAT_TICKS = 30;
const MAX_SOCKET_BACKPRESSURE = 512 * 1024;
const PLAYER_VIEW_RADIUS = 42 * game.TILE;
const MOB_VIEW_RADIUS = 34 * game.TILE;
const ITEM_VIEW_RADIUS = 28 * game.TILE;
const CHEST_VIEW_RADIUS = 30 * game.TILE;

class GameServer {
    constructor() {
        this.wss = null;
        this.clients = new Map(); // userId → ws
        this.tickInterval = null;
        this._mobSpawnCounter = 0;
        this._regenCounter = 0;
        this._heartbeatCounter = 0;
        this._stateSeq = 0;
    }

    init(server) {
        this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
        this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
        this.tickInterval = setInterval(() => this._tick(), TICK_RATE);
        console.log('[OpenVibeGame WS] Game server initialized');
    }

    handleUpgrade(request, socket, head) {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (url.pathname !== '/ws/game') return false;
        const token = url.searchParams.get('token');
        try {
            const identity = resolveGameIdentity({ req: request, token, ip: getRequestIp(request) });
            if (!identity?.user || identity.user.is_banned) {
                socket.destroy();
                return true;
            }
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = identity.user.id;
                ws.username = identity.user.display_name || identity.anonId || identity.user.username;
                ws.anonId = identity.anonId || null;
                ws.isAnon = !!identity.isAnon;
                this.wss.emit('connection', ws, request);
            });
        } catch { socket.destroy(); }
        return true;
    }

    close() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        if (this.wss) this.wss.close();
    }

    // ── Connection lifecycle ────────────────────────────────────

    _onConnection(ws, req) {
        const userId = ws.userId;
        const username = ws.username;
        console.log(`[OpenVibeGame WS] ${username} (${userId}) connected`);

        // Kick existing connection
        const old = this.clients.get(userId);
        if (old) { try { old.close(); } catch {} }
        this.clients.set(userId, ws);

        // Ensure player exists & get data
        const player = game.getPlayer(userId);
        if (!player.display_name) {
            db.run('UPDATE game_players SET display_name = ? WHERE user_id = ?', [username, userId]);
            player.display_name = username;
        }

        // Enrich with OpenCoins from shared users table
        const user = db.getUserById(userId);
        player.openvibe_coins = user?.openvibe_coins_balance || 0;

        // Hat is driven by globally equipped cosmetic, not game inventory
        const cosmeticProfile = cosmetics.getCosmeticProfile(userId);
        const globalHat = cosmeticProfile.hatFX?.itemId || null;
        player.equip_hat = globalHat;

        game.updateLivePlayer(userId, {
            x: player.x, y: player.y, username,
            display_name: player.display_name || username,
            hp: player.hp, max_hp: player.max_hp,
            name_effect: player.name_effect,
            particle_effect: player.particle_effect,
            equip_weapon: player.equip_weapon,
            equip_armor: player.equip_armor,
            equip_hat: player.equip_hat,
            equip_pickaxe: player.equip_pickaxe,
            equip_axe: player.equip_axe,
            equip_rod: player.equip_rod,
            animation: 'idle',
        });

        // Send init payload
        const { NPC_LIST, TOWN_DECO, TOWN_PATHS, VILLAGES } = require('./items');
        this._send(ws, {
            type: 'init',
            player,
            identity: {
                isAnon: !!ws.isAnon,
                anonId: ws.anonId || null,
            },
            agilityBonuses: game.getAgilityBonuses(player.agility_level),
            worldSeed: game.getWorldSeed(),
            mapW: game.MAP_W,
            mapH: game.MAP_H,
            structures: game.getAllStructures(),
            depletedNodes: game.getDepletedNodes(),
            players: game.getLivePlayers(),
            mobs: game.getMobStates(),
            groundItems: game.getGroundItemStates(),
            chests: game.getChestStates(),
            weather: game.getWeather(),
            achievements: game.getAchievements(userId),
            dailyQuests: game.getDailyQuests(userId),
            npcs: NPC_LIST,
            townDeco: TOWN_DECO,
            townPaths: [...TOWN_PATHS],
            villages: VILLAGES,
            weaponStats: game.WEAPON_STATS,
            foodEffects: game.FOOD_EFFECTS,
        });

        // Broadcast join
        this._broadcastExcept(userId, {
            type: 'player_join',
            userId,
            username: player.display_name || username,
        });

        ws.isAlive = true;
        ws._lastMoveAt = Date.now();
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (data) => this._onMessage(ws, data));
        ws.on('close', () => this._onDisconnect(ws));
    }

    _onDisconnect(ws) {
        const userId = ws.userId;
        if (this.clients.get(userId) === ws) {
            this.clients.delete(userId);
            game.removeLivePlayer(userId);
            this._broadcastAll({ type: 'player_leave', userId });
            console.log(`[OpenVibeGame WS] ${ws.username} (${userId}) disconnected`);
        }
    }

    _onMessage(ws, raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        switch (msg.type) {
            case 'move': this._handleMove(ws, msg); break;
            case 'gather': this._handleGather(ws, msg); break;
            case 'fish': this._handleFish(ws, msg); break;
            case 'build': this._handleBuild(ws, msg); break;
            case 'destroy': this._handleDestroy(ws, msg); break;
            case 'attack': this._handleAttack(ws, msg); break;
            case 'attack_mob': this._handleAttackMob(ws, msg); break;
            case 'dodge': this._handleDodge(ws, msg); break;
            case 'eat_food': this._handleEatFood(ws, msg); break;
            case 'pickup': this._handlePickup(ws, msg); break;
            case 'open_chest': this._handleOpenChest(ws, msg); break;
            case 'chat': this._handleChat(ws, msg); break;
            case 'ping': this._send(ws, { type: 'pong', echo: msg.t || null, serverTime: Date.now() }); break;
        }
    }

    // ── Action handlers ─────────────────────────────────────────

    _handleMove(ws, msg) {
        const { x, y, animation, sprinting } = msg;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        const now = Date.now();
        const elapsed = Math.max(TICK_RATE, now - (ws._lastMoveAt || now));
        ws._lastMoveAt = now;
        const current = game.getPlayer(ws.userId);
        const fromX = Number.isFinite(current?.x) ? current.x : x;
        const fromY = Number.isFinite(current?.y) ? current.y : y;
        const maxDistance = Math.max(game.TILE * 2.25, elapsed * 0.20);
        let nextX = x;
        let nextY = y;
        const deltaX = x - fromX;
        const deltaY = y - fromY;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance > maxDistance) {
            const scale = maxDistance / Math.max(distance, 1);
            nextX = fromX + deltaX * scale;
            nextY = fromY + deltaY * scale;
        }
        const clampX = Math.max(0, Math.min(game.MAP_W * game.TILE, nextX));
        const clampY = Math.max(0, Math.min(game.MAP_H * game.TILE, nextY));
        game.updatePlayerPosition(ws.userId, clampX, clampY);
        // Track movement for agility XP (swimming, distance)
        game.trackMovement(ws.userId, clampX, clampY);
        // Sprint stamina drain
        if (sprinting) {
            const canSprint = game.drainSprintStamina(ws.userId);
            if (!canSprint) {
                this._send(ws, { type: 'sprint_exhausted' });
            }
        }
        const existing = game.getLivePlayers()[ws.userId];
        game.updateLivePlayer(ws.userId, {
            x: clampX, y: clampY,
            username: ws.username,
            display_name: ws.username,
            hp: existing?.hp ?? 100,
            max_hp: existing?.max_hp ?? 100,
            name_effect: existing?.name_effect,
            particle_effect: existing?.particle_effect,
            equip_weapon: existing?.equip_weapon,
            equip_armor: existing?.equip_armor,
            equip_hat: existing?.equip_hat,
            equip_pickaxe: existing?.equip_pickaxe,
            equip_axe: existing?.equip_axe,
            equip_rod: existing?.equip_rod,
            animation: animation || 'idle',
        });
    }

    _handleGather(ws, msg) {
        const { tileX, tileY } = msg;
        if (typeof tileX !== 'number' || typeof tileY !== 'number') return;
        const result = game.gather(ws.userId, tileX, tileY);
        this._send(ws, { type: 'gather_result', ...result });
        if (result.success) {
            // Tell all players about the effect and depletion
            this._broadcastAll({
                type: 'gather_effect',
                userId: ws.userId, tileX, tileY,
                action: result.action,
                loot: result.loot,
            });
            this._broadcastAll({
                type: 'node_depleted',
                tileX, tileY,
                respawnAt: result.depletedUntil,
            });
        }
    }

    _handleFish(ws, msg) {
        const { tileX, tileY, reelScore } = msg;
        if (typeof tileX !== 'number' || typeof tileY !== 'number') return;
        const result = game.fish(ws.userId, tileX, tileY, reelScore || 0);
        this._send(ws, { type: 'fish_result', ...result });
        if (result.success && !result.escaped) {
            this._broadcastAll({
                type: 'fish_effect',
                userId: ws.userId, tileX, tileY,
                loot: result.loot, zone: result.zone,
            });
        }
    }

    _handleBuild(ws, msg) {
        const { structureType, tileX, tileY } = msg;
        if (!structureType || typeof tileX !== 'number' || typeof tileY !== 'number') return;
        const result = game.placeStructure(ws.userId, structureType, tileX, tileY);
        this._send(ws, { type: 'build_result', ...result });
        if (result.success) {
            this._broadcastAll({ type: 'structure_placed', structure: result.structure });
        }
    }

    _handleDestroy(ws, msg) {
        const { tileX, tileY } = msg;
        if (typeof tileX !== 'number' || typeof tileY !== 'number') return;
        const result = game.destroyStructure(ws.userId, tileX, tileY);
        this._send(ws, { type: 'destroy_result', ...result });
        if (result.success) {
            this._broadcastAll({ type: 'structure_destroyed', tileX, tileY });
        }
    }

    _handleAttack(ws, msg) {
        const targetId = msg.targetId;
        if (!targetId) return;
        const result = game.attackPlayer(ws.userId, targetId);
        this._send(ws, { type: 'attack_result', ...result });
        if (result.success) {
            const targetWs = this.clients.get(targetId);
            if (targetWs) {
                this._send(targetWs, {
                    type: 'combat_hit',
                    attackerId: ws.userId,
                    dmg: result.dmg, isCrit: result.isCrit,
                    hp: result.targetHp, maxHp: result.targetMaxHp,
                });
            }
            if (result.killed) {
                this._broadcastAll({
                    type: 'player_died',
                    userId: targetId,
                    killerId: ws.userId,
                    killerName: ws.username,
                    deathX: result.deathData.deathX,
                    deathY: result.deathData.deathY,
                    dropped: result.deathData.dropped,
                });
                if (targetWs) {
                    this._send(targetWs, {
                        type: 'respawn',
                        x: result.deathData.spawnX,
                        y: result.deathData.spawnY,
                        dropped: result.deathData.dropped,
                        deathX: result.deathData.deathX,
                        deathY: result.deathData.deathY,
                    });
                }
            }
        }
    }

    _handleAttackMob(ws, msg) {
        const mobId = msg.mobId;
        if (typeof mobId !== 'number') return;
        const result = game.attackMob(ws.userId, mobId);
        this._send(ws, { type: 'mob_attack_result', ...result });
        if (result.success && result.killed) {
            this._broadcastAll({
                type: 'mob_killed',
                mobId, userId: ws.userId, username: ws.username,
                mobName: result.mobName, mobEmoji: result.mobEmoji,
                mobX: result.mobX, mobY: result.mobY,
            });
        }
    }

    _handleDodge(ws, msg) {
        const dx = typeof msg.dx === 'number' ? msg.dx : 0;
        const dy = typeof msg.dy === 'number' ? msg.dy : 0;
        const result = game.dodgeRoll(ws.userId, dx, dy);
        this._send(ws, { type: 'dodge_result', ...result });
        if (result.success) {
            // Broadcast position update so other players see the dodge
            const p = game.getPlayer(ws.userId);
            if (p) {
                const existing = game.getLivePlayers()[ws.userId];
                game.updateLivePlayer(ws.userId, {
                    ...existing, x: p.x, y: p.y, animation: 'dodge',
                });
            }
        }
    }

    _handleEatFood(ws, msg) {
        const itemId = msg.itemId;
        if (typeof itemId !== 'string') return;
        const result = game.eatFood(ws.userId, itemId);
        this._send(ws, { type: 'eat_food_result', ...result });
    }

    _handlePickup(ws, msg) {
        const groundItemId = msg.groundItemId;
        if (typeof groundItemId !== 'number') return;
        const result = game.pickupGroundItem(ws.userId, groundItemId);
        this._send(ws, { type: 'pickup_result', ...result });
        if (result.success) {
            this._broadcastAll({
                type: 'ground_item_pickup',
                groundId: result.groundId,
                userId: ws.userId,
                username: ws.username,
            });
        }
    }

    _handleOpenChest(ws, msg) {
        const chestId = msg.chestId;
        if (typeof chestId !== 'number') return;
        const result = game.openChest(ws.userId, chestId);
        this._send(ws, { type: 'chest_result', ...result });
        if (result.success) {
            this._broadcastAll({
                type: 'chest_opened',
                chestId,
                userId: ws.userId,
                username: ws.username,
                tier: result.tier,
                x: result.x, y: result.y,
            });
        }
    }

    _handleChat(ws, msg) {
        if (!msg.text || typeof msg.text !== 'string') return;
        const text = msg.text.trim().slice(0, 200);
        if (!text) return;
        this._broadcastAll({
            type: 'game_chat',
            userId: ws.userId,
            username: ws.username,
            text,
        });

        // Bridge game chat to global chat so it appears in the Global Chat tab
        try {
            const chatServer = require('../chat/chat-server');
            const user = ws.userId ? db.getUserById(ws.userId) : null;
            const gameChatMsg = {
                type: 'chat',
                username: ws.username,
                user_id: ws.userId || null,
                anon_id: null,
                role: user ? user.role : 'user',
                message: text,
                stream_id: null,
                is_global: true,
                is_game_chat: true,
                avatar_url: user?.avatar_url || null,
                profile_color: user?.profile_color || '#999',
                filtered: false,
                timestamp: new Date().toISOString(),
            };
            chatServer.broadcastGlobal(gameChatMsg);
        } catch { /* non-critical */ }
    }

    // ── Tick (broadcast player positions & node respawns) ───────

    _tick() {
        if (!this.wss || this.clients.size === 0) return;

        // Mob spawning every ~5s (50 ticks)
        if (++this._mobSpawnCounter >= 50) {
            this._mobSpawnCounter = 0;
            game.spawnMobs();
            game.cleanupGroundItems(); // Despawn expired ground items
            game.spawnChests();        // Spawn treasure chests near players
            game.cleanupChests();      // Despawn expired chests
            game.tickWeather();        // Update weather state
        }

        // Mob AI tick every frame
        const mobResult = game.mobTick();

        // Broadcast mob attacks on players
        for (const atk of mobResult.attacks) {
            const targetWs = this.clients.get(parseInt(atk.targetId));
            if (targetWs) {
                this._send(targetWs, {
                    type: 'mob_hit_player',
                    mobId: atk.mobId, mobName: atk.mobName,
                    dmg: atk.dmg, hp: atk.newHp, maxHp: atk.maxHp,
                    dodged: atk.dodged || false,
                });
            }
        }
        // Broadcast mob kills on players
        for (const kill of mobResult.kills) {
            this._broadcastAll({
                type: 'player_died',
                userId: parseInt(kill.targetId),
                killerName: kill.mobName,
                killedByMob: true,
                deathX: kill.deathData.deathX,
                deathY: kill.deathData.deathY,
                dropped: kill.deathData.dropped,
            });
            const targetWs = this.clients.get(parseInt(kill.targetId));
            if (targetWs) {
                this._send(targetWs, {
                    type: 'respawn',
                    x: kill.deathData.spawnX,
                    y: kill.deathData.spawnY,
                    dropped: kill.deathData.dropped,
                    deathX: kill.deathData.deathX,
                    deathY: kill.deathData.deathY,
                });
            }
        }

        // Health regen every ~3s (30 ticks)
        if (++this._regenCounter >= 30) {
            this._regenCounter = 0;
            game.regenHealth();

            // Stamina regen tick (same cadence as health regen)
            const staminaUpdates = game.regenStaminaTick();
            for (const upd of staminaUpdates) {
                const ws = this.clients.get(upd.userId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    this._send(ws, {
                        type: 'stamina_update',
                        stamina: upd.stamina,
                        maxStamina: upd.maxStamina,
                    });
                }
            }
        }

        // Player + mob + ground item + chest + weather states
        const players = game.getLivePlayers();
        const mobs = game.getMobStates();
        const groundItems = game.getGroundItemStates();
        const chests = game.getChestStates();
        const weather = game.getWeather();
        const stateSeq = ++this._stateSeq;

        for (const [uid, ws] of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                const state = this._buildStateForUser(uid, players, mobs, groundItems, chests, weather, stateSeq);
                this._send(ws, state);
            }
        }

        // Flush achievement notifications per player
        for (const [uid, ws] of this.clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            const earned = game.flushPendingAchievements(uid);
            if (earned.length > 0) {
                this._send(ws, { type: 'achievements_earned', achievements: earned });
            }
        }

        // Heartbeat every 3s
        if (++this._heartbeatCounter >= HEARTBEAT_TICKS) {
            this._heartbeatCounter = 0;
            for (const [uid, ws] of this.clients) {
                if (!ws.isAlive) { ws.terminate(); this._onDisconnect(ws); continue; }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            }
        }
    }

    _buildStateForUser(userId, players, mobs, groundItems, chests, weather, seq) {
        const self = players[userId] || game.getPlayer(userId);
        const cx = Number(self?.x) || 0;
        const cy = Number(self?.y) || 0;
        const within = (obj, radius) => {
            const dx = (Number(obj?.x) || 0) - cx;
            const dy = (Number(obj?.y) || 0) - cy;
            return (dx * dx + dy * dy) <= radius * radius;
        };

        const nearbyPlayers = {};
        for (const [id, player] of Object.entries(players)) {
            if (String(id) === String(userId) || within(player, PLAYER_VIEW_RADIUS)) nearbyPlayers[id] = player;
        }

        const nearbyMobs = {};
        for (const [id, mob] of Object.entries(mobs)) {
            if (within(mob, MOB_VIEW_RADIUS)) nearbyMobs[id] = mob;
        }

        const nearbyItems = {};
        for (const [id, item] of Object.entries(groundItems)) {
            if (within(item, ITEM_VIEW_RADIUS)) nearbyItems[id] = item;
        }

        const nearbyChests = {};
        for (const [id, chest] of Object.entries(chests)) {
            if (within(chest, CHEST_VIEW_RADIUS)) nearbyChests[id] = chest;
        }

        return {
            type: 'state',
            seq,
            serverTime: Date.now(),
            players: nearbyPlayers,
            mobs: nearbyMobs,
            groundItems: nearbyItems,
            chests: nearbyChests,
            weather,
        };
    }

    // ── Transport helpers ───────────────────────────────────────

    _send(ws, data) {
        if (ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount > MAX_SOCKET_BACKPRESSURE) return;
            try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
        }
    }

    _broadcastAll(data) {
        const msg = JSON.stringify(data);
        for (const [uid, ws] of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > MAX_SOCKET_BACKPRESSURE) continue;
                try { ws.send(msg); } catch {}
            }
        }
    }

    _broadcastExcept(excludeId, data) {
        const msg = JSON.stringify(data);
        for (const [uid, ws] of this.clients) {
            if (uid !== excludeId && ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > MAX_SOCKET_BACKPRESSURE) continue;
                try { ws.send(msg); } catch {}
            }
        }
    }
}

module.exports = new GameServer();
