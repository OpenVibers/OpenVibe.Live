'use strict';
/**
 * Elements, stage 1: the streamer's library, the store each element keeps, and the presses that
 * authorise a run (owner ask 2026-11-11; design in ~/openvibe/research-2026-11-11/elements.md).
 *
 * An element is a look, a recipe (triggers -> conditions -> actions) and the capabilities it
 * declares. This module keeps the rows and validates every save through openvibe-sdk/elements, so
 * the editor, the API and the press path all speak the same language. It never runs an action: the
 * press path (./press.js) asks Live, Bot and Chat, and each of those checks again.
 *
 *   list(userId)                    the owner's library, newest change first
 *   create(userId, body)            validate through the SDK, then insert (and its empty state)
 *   update(userId, publicId, body)  validate the merged element; the revision moves by one
 *   remove(userId, publicId)
 *   forChannel(userId)              the channel row a deck belongs to (created on first save)
 *   channelByUsername(name)          the public channel row a viewer's deck names
 *   deck(userId)                    the active elements in order, with their state
 *   enabled(userId) / setEnabled()  the owner switch: off until the streamer turns it on
 *   chatCommands(userId)            the channel's chat_command triggers, cached 30 s
 *   stateOf(element) / applyState() the element's own store, through the SDK reducer
 *   limitsFor(element, presserId)   cooldowns and daily caps from element_press_log
 *   recordPress(...)                the press-log row the limits read
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const db = require('../db/database');
const identity = require('../auth/identity-sync');

const ID_PREFIX = 'el_';
const CACHE_MS = 30 * 1000;
const MAX_LOOK_BYTES = 32 * 1024;
const MAX_RECIPE_BYTES = 48 * 1024;

class ElementError extends Error {
    constructor(status, code, message, errors) {
        super(message);
        this.name = 'ElementError';
        this.status = status;
        this.code = code;
        if (errors) this.errors = errors;
    }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (v, d) => {
    if (v == null) return d;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return d; }
};
const iso = (v) => {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? String(v) : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const publicId = () => ID_PREFIX + contracts.ids.ulid();
const nowIso = () => new Date().toISOString();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** openvibe-sdk/elements, loaded lazily so a release that does not have it cannot stop the site booting. */
let sdk = null;
let sdkError = null;
function elementsSdk() {
    if (sdk) return sdk;
    if (sdkError) throw new ElementError(503, 'elements_unavailable', 'The element runtime is not available on this release.');
    try { sdk = require('openvibe-sdk/elements'); } catch (e) { sdkError = e; throw new ElementError(503, 'elements_unavailable', 'The element runtime is not available on this release.'); }
    return sdk;
}

// ── Channel and owner ────────────────────────────────────────────────────────
/** The channel a streamer's library belongs to; a person who has never streamed gets one on first save. */
async function forChannel(userId) {
    const channel = await db.getChannelByUserId(userId);
    return channel || await db.ensureChannel(userId);
}

async function channelByUsername(username) {
    const name = String(username || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) return null;
    return await db.getChannelByUsername(name);
}

async function ownerOf(channel) {
    return await db.getUserById(channel.user_id);
}

// ── Reads ────────────────────────────────────────────────────────────────────
function shape(row, state) {
    const look = json(row.look, {});
    const recipe = json(row.recipe, {});
    const capabilities = json(row.capabilities, []);
    return {
        id: row.public_id,
        revision: Number(row.revision) || 1,
        name: row.name,
        description: row.description || undefined,
        sharing: row.sharing,
        active: !!Number(row.active),
        position: Number(row.position) || 0,
        look,
        recipe,
        capabilities,
        initial_state: json(row.initial_state, {}),
        mod: json(row.mod, undefined),
        state: { revision: Number(state && state.revision) || 0, values: json(state && state.values, {}) },
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

/** One stored element, or null. Owner-scoped: another person's id is the same 404 as a missing one. */
async function byPublicId(userId, id) {
    if (!/^el_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) return null;
    const row = await db.get('SELECT * FROM elements WHERE user_id = ? AND public_id = ?', [userId, String(id)]);
    if (!row) return null;
    const state = await db.get('SELECT revision, values FROM element_state WHERE element_id = ?', [row.id]);
    return { row, state, element: shape(row, state) };
}

/** The owner's whole library, with each element's state and active order. */
async function list(userId) {
    const rows = await db.all('SELECT * FROM elements WHERE user_id = ? ORDER BY position ASC, id ASC', [userId]);
    if (!rows.length) return [];
    const states = new Map((await db.all(
        'SELECT element_id, revision, values FROM element_state WHERE element_id = ANY(?)', [rows.map((r) => r.id)],
    )).map((s) => [String(s.element_id), s]));
    return rows.map((r) => shape(r, states.get(String(r.id))));
}

/** The active elements a viewer's deck shows, in the streamer's order. */
async function deck(userId) {
    const rows = await db.all('SELECT * FROM elements WHERE user_id = ? AND active = 1 ORDER BY position ASC, id ASC', [userId]);
    if (!rows.length) return [];
    const states = new Map((await db.all(
        'SELECT element_id, revision, values FROM element_state WHERE element_id = ANY(?)', [rows.map((r) => r.id)],
    )).map((s) => [String(s.element_id), s]));
    return rows.map((r) => ({ row: r, element: shape(r, states.get(String(r.id))) }));
}

// ── The owner switch ─────────────────────────────────────────────────────────
async function settings(userId) {
    const channel = await forChannel(userId);
    return { enabled: !!Number(channel.deck_enabled) };
}

async function setEnabled(userId, enabled) {
    const channel = await forChannel(userId);
    await db.run('UPDATE channels SET deck_enabled = ? WHERE id = ?', [enabled ? 1 : 0, channel.id]);
    return { enabled: !!enabled };
}

// ── Validation through the SDK ────────────────────────────────────────────────
async function authorFor(user) {
    const author = { name: String(user.display_name || user.username || 'Someone').slice(0, 80) };
    try { const subject = await identity.subjectOf(user.id); if (subject) author.subject = { type: 'user', id: subject }; } catch { /* the display name is enough */ }
    return author;
}

function checkSize(name, value, max) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > max) throw new ElementError(413, 'element.too_large', `${name} is too large (${Math.ceil(max / 1024)} KB at most).`);
}

/** Validate the element as the SDK sees it; throws a 400 with the plain reasons when it is not valid. */
async function validateInput(user, body, { id, revision } = {}) {
    if (!isObject(body)) throw new ElementError(400, 'element.invalid', 'The element must be a JSON object.');
    const element = {
        name: body.name,
        description: body.description,
        author: await authorFor(user),
        sharing: body.sharing || 'private',
        look: body.look,
        recipe: body.recipe,
        capabilities: body.capabilities,
        initial_state: body.initial_state,
        mod: body.mod,
    };
    if (id) { element.id = id; element.revision = revision; }
    checkSize('The look', element.look, MAX_LOOK_BYTES);
    checkSize('The recipe', element.recipe, MAX_RECIPE_BYTES);
    const result = elementsSdk().validate(element);
    if (!result.valid) throw new ElementError(400, 'element.invalid', 'That element is not valid.', result.errors);
    return element;
}

// ── Writes ────────────────────────────────────────────────────────────────────
async function create(user, body) {
    const element = await validateInput(user, body);
    const channel = await forChannel(user.id);
    const active = body.active === undefined ? true : !!body.active;
    const position = Number.isInteger(body.position) ? Math.max(0, Math.min(1000, body.position)) : 0;
    const id = publicId();
    const row = await db.get(`INSERT INTO elements
        (public_id, user_id, name, description, look, recipe, capabilities, initial_state, mod, sharing, active, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, [
        id, user.id, element.name, element.description || null,
        JSON.stringify(element.look), JSON.stringify(element.recipe), JSON.stringify(element.capabilities),
        JSON.stringify(element.initial_state || {}), element.mod ? JSON.stringify(element.mod) : null,
        element.sharing, active ? 1 : 0, position,
    ]);
    await db.run('INSERT INTO element_state (element_id, revision, values) VALUES (?, 0, ?)', [row.id, JSON.stringify(element.initial_state || {})]);
    invalidateCommands(user.id);
    return shape(row, { revision: 0, values: JSON.stringify(element.initial_state || {}) });
}

/** Merge a patch into the stored element, validate the whole thing, then save. */
async function update(user, id, body) {
    if (!isObject(body)) throw new ElementError(400, 'element.invalid', 'The element must be a JSON object.');
    const found = await byPublicId(user.id, id);
    if (!found) throw new ElementError(404, 'element.not_found', 'That element does not exist.');
    const current = found.element;
    const merged = {
        name: body.name !== undefined ? body.name : current.name,
        description: body.description !== undefined ? body.description : current.description,
        sharing: body.sharing !== undefined ? body.sharing : current.sharing,
        look: body.look !== undefined ? body.look : current.look,
        recipe: body.recipe !== undefined ? body.recipe : current.recipe,
        capabilities: body.capabilities !== undefined ? body.capabilities : current.capabilities,
        initial_state: body.initial_state !== undefined ? body.initial_state : current.initial_state,
        mod: body.mod !== undefined ? body.mod : current.mod,
    };
    const element = await validateInput(user, merged, { id: current.id, revision: current.revision });
    const active = body.active === undefined ? (current.active ? 1 : 0) : (body.active ? 1 : 0);
    const position = body.position === undefined ? current.position : Math.max(0, Math.min(1000, Number(body.position) || 0));
    const row = await db.get(`UPDATE elements SET name = ?, description = ?, look = ?, recipe = ?, capabilities = ?,
            initial_state = ?, mod = ?, sharing = ?, active = ?, position = ?, revision = revision + 1, updated_at = ov_now()
        WHERE id = ? AND user_id = ? RETURNING *`, [
        element.name, element.description || null,
        JSON.stringify(element.look), JSON.stringify(element.recipe), JSON.stringify(element.capabilities),
        JSON.stringify(element.initial_state || {}), element.mod ? JSON.stringify(element.mod) : null,
        element.sharing, active, position, found.row.id, user.id,
    ]);
    // A changed initial state is the starting store only while nothing has run; a live counter is never reset.
    if (body.initial_state !== undefined && Number(found.state && found.state.revision) === 0) {
        await db.run('UPDATE element_state SET values = ? WHERE element_id = ?', [JSON.stringify(element.initial_state || {}), found.row.id]);
    }
    invalidateCommands(user.id);
    const state = await db.get('SELECT revision, values FROM element_state WHERE element_id = ?', [found.row.id]);
    return shape(row, state);
}

async function remove(user, id) {
    const found = await byPublicId(user.id, id);
    if (!found) throw new ElementError(404, 'element.not_found', 'That element does not exist.');
    await db.run('DELETE FROM elements WHERE id = ? AND user_id = ?', [found.row.id, user.id]);
    invalidateCommands(user.id);
    return { removed: true, id: found.row.public_id };
}

// ── The element's own store ───────────────────────────────────────────────────
async function stateOf(row) {
    const state = await db.get('SELECT revision, values FROM element_state WHERE element_id = ?', [row.id]);
    return { revision: Number(state && state.revision) || 0, values: json(state && state.values, {}) };
}

/**
 * Apply one screen.counter or screen.state action through the SDK reducer and persist it with an
 * optimistic revision check. Returns the new { revision, values } or throws a refusal.
 */
async function applyState(row, action) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await stateOf(row);
        const next = elementsSdk().reduce(current, [action]);
        if (next.errors && next.errors.length) throw new ElementError(400, 'element.invalid_state', next.errors[0].message, next.errors);
        if (!next.changed) return { revision: current.revision, values: current.values, changed: false };
        const updated = await db.run('UPDATE element_state SET revision = ?, values = ?, updated_at = ov_now() WHERE element_id = ? AND revision = ?',
            [next.revision, JSON.stringify(next.values), row.id, current.revision]);
        if (Number(updated.changes) > 0) return { revision: next.revision, values: next.values, changed: true };
    }
    throw new ElementError(409, 'element.state_conflict', 'The element changed at the same time; try again.');
}

// ── Limits: cooldowns and daily caps, from the press log ─────────────────────
const LIMIT_COL = { person: 'presser_id = ?', overall: '1 = 1' };

/** The element's conditions, as the SDK reads them. */
function conditionsOf(row) {
    const recipe = json(row.recipe, {});
    return isObject(recipe.conditions) ? recipe.conditions : {};
}

function limitsFor(row, presserId, { source = 'press', points = 0 } = {}) {
    const conditions = conditionsOf(row);
    const cooldown = conditions.cooldown || {};
    const cap = conditions.daily_cap || {};
    return {
        async cooldown({ scope, at }) {
            const seconds = Number(scope === 'person' ? cooldown.per_person_seconds : cooldown.overall_seconds) || 0;
            if (!seconds) return 0;
            const where = LIMIT_COL[scope];
            const args = scope === 'person' ? [row.id, presserId] : [row.id];
            const last = await db.get(`SELECT MAX(created_at) AS at FROM element_press_log WHERE element_id = ? AND ${where}`, args);
            const lastMs = last && last.at ? Date.parse(String(last.at).includes('T') ? last.at : `${String(last.at).replace(' ', 'T')}Z`) : 0;
            if (!lastMs) return 0;
            return Math.max(0, lastMs + seconds * 1000 - at);
        },
        async dailyCount({ scope, day }) {
            const max = scope === 'person' ? cap.per_person : cap.overall;
            if (!max) return 0;
            const where = LIMIT_COL[scope];
            const args = scope === 'person' ? [row.id, presserId] : [row.id];
            const start = `${day}T00:00:00.000Z`;
            const rowCount = await db.get(`SELECT COUNT(*) AS n FROM element_press_log WHERE element_id = ? AND ${where} AND created_at >= ?`, [...args, start]);
            return Number(rowCount && rowCount.n) || 0;
        },
        async hit({ at }) {
            await recordPress({ row, presserId, source, points, at });
        },
    };
}

/**
 * The press-log row: the per-person/overall cooldown evidence, the daily counter and the moment's
 * own date. `at` is milliseconds; the log keeps UTC ISO text like the rest of the schema.
 */
async function recordPress({ row, presserId, source, points, at }) {
    const when = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
    await db.run('INSERT INTO element_press_log (element_id, presser_id, source, points, created_at) VALUES (?, ?, ?, ?, ?)',
        [row.id, presserId || null, source === 'chat' ? 'chat' : 'press', Math.max(0, Number(points) || 0), when]);
}

/** How many times this presser (or anyone) may still fire today, for the deck's hint. */
async function remainingToday(row, presserId, at) {
    const cap = conditionsOf(row).daily_cap || {};
    const day = dayOf(at);
    const out = { per_person: null, overall: null };
    if (cap.per_person) {
        const r = await db.get('SELECT COUNT(*) AS n FROM element_press_log WHERE element_id = ? AND presser_id = ? AND created_at >= ?', [row.id, presserId, `${day}T00:00:00.000Z`]);
        out.per_person = Math.max(0, Number(cap.per_person) - (Number(r && r.n) || 0));
    }
    if (cap.overall) {
        const r = await db.get('SELECT COUNT(*) AS n FROM element_press_log WHERE element_id = ? AND created_at >= ?', [row.id, `${day}T00:00:00.000Z`]);
        out.overall = Math.max(0, Number(cap.overall) - (Number(r && r.n) || 0));
    }
    return out;
}

async function cooldownLeft(row, presserId, at) {
    const cooldown = conditionsOf(row).cooldown || {};
    let left = 0;
    for (const scope of ['person', 'overall']) {
        const seconds = Number(scope === 'person' ? cooldown.per_person_seconds : cooldown.overall_seconds) || 0;
        if (!seconds) continue;
        const args = scope === 'person' ? [row.id, presserId] : [row.id];
        const last = await db.get(`SELECT MAX(created_at) AS at FROM element_press_log WHERE element_id = ? AND ${LIMIT_COL[scope]}`, args);
        const lastMs = last && last.at ? Date.parse(String(last.at).includes('T') ? last.at : `${String(last.at).replace(' ', 'T')}Z`) : 0;
        if (lastMs) left = Math.max(left, lastMs + seconds * 1000 - at);
    }
    return left;
}

/** A stable key for one press's points debit and its refund. */
const newPressKey = (elementId, presserId, at) => `element:${elementId}:${presserId || 'anon'}:${at}:${crypto.randomBytes(8).toString('hex')}`;

// ── The chat_command trigger cache ────────────────────────────────────────────
const commandCache = new Map();   // user id -> { at, byCommand: Map<command, element public id> }

function commandsFor(userId) {
    return commandCache.get(String(userId)) || null;
}

function invalidateCommands(userId) {
    commandCache.delete(String(userId));
}

/**
 * The channel's active elements that listen for a chat command, keyed by the command. Cached 30 s
 * and invalidated on every save, so a busy chat does not read the library per message.
 */
async function chatCommands(userId) {
    const key = String(userId);
    const hit = commandCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.byCommand;
    const rows = await db.all("SELECT * FROM elements WHERE user_id = ? AND active = 1 AND recipe::text LIKE '%chat_command%'", [userId]);
    const byCommand = new Map();
    for (const row of rows) {
        const recipe = json(row.recipe, {});
        for (const trigger of Array.isArray(recipe.triggers) ? recipe.triggers : []) {
            if (trigger && trigger.kind === 'chat_command' && /^![a-z0-9_-]{1,32}$/.test(String(trigger.command))) {
                const command = String(trigger.command).toLowerCase();
                if (!byCommand.has(command)) byCommand.set(command, []);
                byCommand.get(command).push(row);
            }
        }
    }
    commandCache.set(key, { at: Date.now(), byCommand });
    if (commandCache.size > 5000) commandCache.clear();
    return byCommand;
}

module.exports = {
    ElementError, elementsSdk,
    forChannel, channelByUsername, ownerOf,
    byPublicId, list, deck, shape, json,
    settings, setEnabled,
    create, update, remove,
    stateOf, applyState, conditionsOf, limitsFor, recordPress, remainingToday, cooldownLeft, newPressKey,
    chatCommands, invalidateCommands,
    dayOf,
};
