'use strict';
/**
 * Elements, stage 1: one press, authorised by Live and run through openvibe-sdk/elements.
 *
 * A press is never an element's own power. Live checks the viewer's role (owner, channel moderator,
 * VIP or subscriber, follower, everyone), whether the channel is live, the element's cooldowns and
 * daily caps, and its channel-points cost (Live's own ledger, debited atomically); then each action
 * is sent to the product that owns it: Live's screen and stream actions here, Bot's command path
 * for a robot (turns, operators, limits, Stop and owner takeover are Bot's), Chat's
 * ingress for a message. A refusal from any of them stops the run and refunds the points.
 *
 * The press is shown on stream through the existing overlay alert feed with the presser's name,
 * written to the stream's AI timeline as a moment, and announced as live.element.pressed@1. A
 * screen.counter/screen.state action moves the element's own store and Live broadcasts the new
 * state as live.element.state@1 (and as an `element-state` frame in the channel room).
 *
 * Chat commands come in through Chat's existing /internal/chat-effects/chat-message effect; the
 * same run authorises them, with the chatter as the presser.
 */
const db = require('../db/database');
const identity = require('../auth/identity-sync');
const permissions = require('../auth/permissions');
const billing = require('../monetization/billing-actions');
const delivery = require('../chat/chat-delivery');
const overlay = require('../overlay/overlay-alerts');
const bot = require('../bot/bot-client');
const streamEvents = require('../events/stream-events');
const store = require('./store');

const STATUS = {
    disabled: 404, offline: 409, not_found: 404, not_active: 404,
    capability: 403, role: 403, points: 402, cooldown: 429, daily_cap: 429,
    not_live: 409, robot_turn: 409, chance: 409, action: 409, limits: 500,
    invalid: 400, trigger: 400, signed_out: 401, disabled_action: 409,
};

const ROBOT_PRESETS = { up: 1, center: 0, down: -1 };

const refuse = (code, message, extra = {}) => ({ ok: false, code, message, status: STATUS[code] || 400, ...extra });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const RANK = { everyone: 0, follower: 1, subscriber: 2, vip: 3, operator: 4, owner: 5 };

/**
 * The highest role this person holds in this channel, for a condition that needs `need`. The answer is
 * enough to decide that condition (a rank), not a full audit: an everyone-only deck does not ask Chat
 * or Billing anything, and a follower-only one asks them only for a person who does not follow.
 */
async function roleOf(channel, user, hints = {}, need = 'owner') {
    if (!user || !user.id) return { role: null, signedIn: false };
    const needRank = RANK[need] || 0;
    if (Number(user.id) === Number(channel.user_id)) return { role: 'owner', signedIn: true };
    if (hints.isStreamer) return { role: 'owner', signedIn: true };
    if (needRank === 0) return { role: 'everyone', signedIn: true };
    if (hints.isMod) return { role: 'operator', signedIn: true };
    try { if (await permissions.isChannelModerator(user, channel.user_id)) return { role: 'operator', signedIn: true }; } catch { /* Chat may be unreachable; fall through */ }
    // A channel bound to a robot: Bot's own operators are the People Operators the design names. Bot
    // answers this with the control capability, and the command itself is still Bot's decision.
    if (channel.bot_robot_id) {
        try {
            const subject = await identity.subjectOf(user.id);
            const held = subject ? await bot.role(channel.bot_robot_id, subject) : null;
            if (held === 'owner' || held === 'operator') return { role: 'operator', signedIn: true };
        } catch { /* Bot is unreachable; a channel moderator still counts */ }
    }
    // A follower is the cheapest answer, so a follower-only element asks the follows table first. A
    // non-follower then asks Billing/VIP, because a subscriber is above a follower even without Follow.
    if (needRank <= RANK.follower) {
        try {
            const follow = await db.get('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND streamer_id = ?', [user.id, channel.user_id]);
            if (follow) return { role: 'follower', signedIn: true };
        } catch { /* no follows table answer */ }
    }
    if (needRank <= RANK.vip) {
        // Subscriber and VIP: one Billing/VIP answer covers both.
        try {
            const subject = await identity.subjectOf(user.id);
            const creator = await identity.subjectOf(channel.user_id);
            if (subject && creator) {
                const e = await billing.entitlementOf(subject, creator);
                if (e && e.active) return { role: e.via === 'vip' ? 'vip' : 'subscriber', signedIn: true };
            }
        } catch { /* Billing or VIP is unreachable; no extra tier */ }
    }
    return { role: 'everyone', signedIn: true };
}

/** The public channel facts the pressed event and the overlay carry. */
const channelFacts = (channel) => ({
    username: channel.username,
    display_name: channel.display_name || channel.username,
});

/** The presser's public name, never an email or an account id. */
const nameOf = (user) => String((user && (user.display_name || user.username)) || 'Someone').slice(0, 120);

/** The element's cost in channel points, from its recipe's conditions. */
const costOf = (row) => {
    const c = store.conditionsOf(row).cost;
    return c && Number.isInteger(c.points) ? c.points : 0;
};

/**
 * Send one action to the product that authorises it. Returns { ok, result?, message? }.
 * `changed` is shared with the caller so one broadcast follows a run that moved the store.
 */
async function send({ channel, presser, user, row, element, live, action, pressId, changed }) {
    switch (action.kind) {
        case 'screen.counter':
        case 'screen.state': {
            const next = await store.applyState(row, action);
            if (next.changed) changed.revision = next.revision;
            return { ok: true, result: next };
        }
        case 'screen.alert': {
            const frame = await overlay.emit({
                streamerId: channel.user_id,
                kind: 'element',
                who: { name: nameOf(presser), avatar: presser && presser.avatar_url ? presser.avatar_url : null },
                text: String(action.title).slice(0, 80),
                naturalKey: `${pressId}:alert:${action.title}`,
            });
            return frame ? { ok: true, result: { id: frame.id } } : { ok: true, result: null };
        }
        case 'stream.moment': {
            const at = elapsedSeconds(live);
            const n = await db.addTimelineEvents([{
                stream_id: live.id, user_id: channel.user_id, kind: 'element', start_sec: at,
                text: `${nameOf(presser)} pressed ${element.name}${action.label ? `: ${String(action.label).slice(0, 120)}` : ''}`,
                label: String(action.label || element.name).slice(0, 120),
            }]);
            return n ? { ok: true, result: { at } } : { ok: false, message: 'The timeline did not take it.' };
        }
        case 'chat.message': {
            const id = await delivery.message({
                stream_id: live.id, channel_user_id: channel.user_id, user_id: null,
                username: 'Deck', message: String(action.text).slice(0, 400), message_type: 'system',
                key: `element:${pressId}:chat`,
            });
            return id ? { ok: true, result: { message_id: id } } : { ok: false, message: 'Chat is not available right now.' };
        }
        case 'robot.drive_pulse': {
            const robotId = channel.bot_robot_id;
            if (!robotId) return { ok: false, message: 'This channel has no robot bound.' };
            if (!user || !user.id) return { ok: false, message: 'Sign in to drive the robot.' };
            const subject = await subjectOf(user);
            if (!subject) return { ok: false, message: 'Sign in with OpenVibe.Network to drive the robot.' };
            const speed = action.speed == null ? 1 : Number(action.speed);
            const value = action.direction === 'forward' ? { throttle: speed, steer: 0 }
                : action.direction === 'back' ? { throttle: -speed, steer: 0 }
                    : action.direction === 'left' ? { throttle: 0, steer: speed }
                        : action.direction === 'right' ? { throttle: 0, steer: -speed }
                            : action.direction === 'spin_left' ? { throttle: 0, steer: speed }
                                : { throttle: 0, steer: -speed };
            return await robotCommand(robotId, subject, { kind: 'drive', value, ms: action.ms });
        }
        case 'robot.head_preset': {
            const robotId = channel.bot_robot_id;
            if (!robotId) return { ok: false, message: 'This channel has no robot bound.' };
            if (!user || !user.id) return { ok: false, message: 'Sign in to move the robot.' };
            const subject = await subjectOf(user);
            if (!subject) return { ok: false, message: 'Sign in with OpenVibe.Network to move the robot.' };
            const angle = ROBOT_PRESETS[String(action.preset).toLowerCase()];
            if (angle === undefined) return { ok: false, message: `"${String(action.preset).slice(0, 40)}" is not a head preset (up, center or down).` };
            return await robotCommand(robotId, subject, { kind: 'actuator', value: { name: 'head', value: angle } });
        }
        case 'robot.headlight': {
            const robotId = channel.bot_robot_id;
            if (!robotId) return { ok: false, message: 'This channel has no robot bound.' };
            if (!user || !user.id) return { ok: false, message: 'Sign in to use the robot\'s lights.' };
            const subject = await subjectOf(user);
            if (!subject) return { ok: false, message: 'Sign in with OpenVibe.Network to use the robot\'s lights.' };
            // Bot's headlight kind (LOOI headlights, dsh:looi-headlights-1111d) is the authority; before it
            // ships this is Bot's own unknown-command refusal, never a Live-side substitute.
            return await robotCommand(robotId, subject, { kind: 'headlight', value: { on: !!action.on } });
        }
        case 'robot.say': {
            const robotId = channel.bot_robot_id;
            if (!robotId) return { ok: false, message: 'This channel has no robot bound.' };
            if (!user || !user.id) return { ok: false, message: 'Sign in to make the robot speak.' };
            const subject = await subjectOf(user);
            if (!subject) return { ok: false, message: 'Sign in with OpenVibe.Network to make the robot speak.' };
            return await robotCommand(robotId, subject, { kind: 'say', value: { text: String(action.text).slice(0, 300) } });
        }
        default:
            return { ok: false, message: `${action.kind} is not available in stage 1 of Elements.` };
    }
}

async function robotCommand(robotId, subject, body) {
    try {
        const answer = await bot.command(robotId, subject, { id: `el_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, ...body });
        return { ok: true, result: answer && answer.result !== undefined ? answer.result : null };
    } catch (e) {
        if (e instanceof bot.BotRefusal) return { ok: false, message: e.message || 'The robot refused it.', code: e.code };
        return { ok: false, message: 'The robot is not reachable right now.' };
    }
}

const subjectOf = async (user) => {
    if (!user || !user.id) return null;
    try { return await identity.subjectOf(user.id); } catch { return null; }
};

const elapsedSeconds = (live) => {
    const started = live && live.started_at ? Date.parse(String(live.started_at).includes('T') ? live.started_at : `${String(live.started_at).replace(' ', 'T')}Z`) : NaN;
    return Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
};

/**
 * Run one element for one fired trigger. Never throws for a refusal; returns
 * { ok, status, code?, message?, state?, balance?, points_spent?, actions? }.
 */
async function run({ channel, presser, row, element, trigger, source = 'press' }) {
    if (!channel || !Number(channel.deck_enabled)) return refuse('disabled', 'This channel has not opened its deck.');
    const live = (await db.getLiveStreamsByUserId(channel.user_id) || [])[0];
    if (!live || !live.is_live) return refuse('offline', 'The deck runs while the channel is live.');

    const needed = (store.conditionsOf(row).role) || 'everyone';
    const { role } = await roleOf(channel, presser, trigger && trigger.hints ? trigger.hints : {}, needed);
    const actorName = nameOf(presser);
    const subject = await subjectOf(presser);
    const now = Date.now();
    const pressId = store.newPressKey(element.id, presser && presser.id, now);
    const changed = { revision: 0 };
    const points = costOf(row);
    let spent = 0;
    let balance = null;

    const stateBefore = Number((await store.stateOf(row)).revision) || 0;
    const limits = store.limitsFor(row, presser && presser.id, { source, points });
    const ctx = {
        now,
        isLive: true,
        element: { id: element.id, name: element.name, capabilities: element.capabilities },
        actor: { subject: subject ? { type: 'user', id: subject } : undefined, role: role || 'everyone', name: actorName },
        limits,
        spend: async ({ points: cost }) => {
            if (!presser || !presser.id) return { ok: false, message: 'Sign in to spend channel points.' };
            const r = await db.applyChannelPoints({ userId: presser.id, streamerId: channel.user_id, delta: -cost, key: pressId, reason: `element:${String(element.name).slice(0, 80)}` });
            if (r.applied || r.replayed) { spent = cost; balance = r.balance; return { ok: true, balance: r.balance }; }
            balance = r.balance;
            return { ok: false, message: `Not enough channel points (${Number(r.balance) || 0} of ${cost}).` };
        },
        refund: async ({ points: cost }) => {
            if (!presser || !presser.id || !cost) return;
            try {
                const r = await db.applyChannelPoints({ userId: presser.id, streamerId: channel.user_id, delta: cost, key: `refund:${pressId}`, reason: `element refund:${String(element.name).slice(0, 70)}` });
                if (r.applied || r.replayed) { spent = 0; balance = r.balance; }
            } catch { /* the ledger decides; the refusal is reported either way */ }
        },
        send: async (action) => await send({ channel, presser, user: presser, row, element, live, action, pressId, changed }),
    };

    const result = await store.elementsSdk().run(element.recipe, trigger.trigger, ctx);
    if (!result.ok) {
        // A state action that already ran is still true, so viewers get the new store even though the
        // press as a whole was refused and the points went back. The moment itself is not announced.
        try {
            const nowState = await store.stateOf(row);
            if (Number(nowState.revision) > stateBefore) await announceState({ channel, row, element, state: nowState, live });
        } catch { /* the refusal is the answer */ }
        return refuse(result.code, result.message, {
            retry_after_ms: result.retryAfterMs, scope: result.scope, refused_action: result.refusedAction,
            refunded: !!result.refunded, points_spent: result.refunded ? 0 : (Number(result.pointsSpent) || 0),
        });
    }

    const state = await store.stateOf(row);
    const stateRevision = Number(state.revision) || 0;
    if (stateRevision > stateBefore) {
        await announceState({ channel, row, element, state, live });
    }
    const presserSubject = subject ? { type: 'user', id: subject } : null;
    await announcePress({ channel, row, element, presser, actorName, presserSubject, trigger: trigger.trigger, points: result.pointsSpent || spent, stateRevision, live });
    if (presser && presser.id) {
        try { balance = await db.getChannelPoints(presser.id, channel.user_id); } catch { /* the response can go without it */ }
    }
    return {
        ok: true, status: 200, code: null,
        state: { revision: state.revision, values: state.values },
        points_spent: result.pointsSpent || 0,
        balance: balance == null ? null : Number(balance),
        actions: result.actions.map((a) => ({ kind: a.action.kind, product: a.action.product })),
        cooldown_ms: await store.cooldownLeft(row, presser && presser.id, Date.now()),
    };
}

/** The overlay moment: "Maticus pressed Make it dance" with the public name only. */
async function announcePress({ channel, row, element, presser, actorName, presserSubject, trigger, points, stateRevision, live }) {
    const at = new Date().toISOString();
    try {
        await overlay.emit({
            streamerId: channel.user_id,
            kind: 'element',
            who: { name: actorName, avatar: presser && presser.avatar_url ? presser.avatar_url : null },
            text: String(element.name).slice(0, 80),
            naturalKey: `${row.public_id}:${at}:${actorName}`,
        });
    } catch { /* the press happened even if the overlay feed is off */ }
    try {
        const atSec = elapsedSeconds(live);
        await db.addTimelineEvents([{
            stream_id: live.id, user_id: channel.user_id, kind: 'element', start_sec: atSec,
            text: `${actorName} pressed ${element.name}${points ? ` (${points} points)` : ''}`,
            label: String(element.name).slice(0, 120),
        }]);
    } catch { /* the timeline is best effort */ }
    if (!presserSubject) return;   // the pressed event's presser is a subject; an unlinked account has none
    try {
        streamEvents.init();
        const envelope = {
            event_type: 'live.element.pressed',
            actor: presserSubject,
            subject: { type: 'element', id: row.public_id },
            visibility: 'public',
            priority: 'low',
            payload: {
                channel: channelFacts(channel),
                element_id: row.public_id,
                element_name: element.name,
                presser: presserSubject,
                presser_name: actorName,
                trigger,
                points_spent: Number(points) || 0,
                state_revision: Number(stateRevision) || 0,
                at,
            },
        };
        await db.getDb().tx(async () => { await streamEvents.enqueue(envelope); });
        streamEvents.kick();
    } catch { /* the event is durable when the outbox is on; the press is not repeated for it */ }
}

/** Broadcast the store to everyone watching, through the same channel room the overlay listens on. */
async function announceState({ channel, row, element, state, live }) {
    const payload = {
        channel: channelFacts(channel), element_id: row.public_id,
        revision: Number(state.revision) || 0, values: state.values, updated_at: new Date().toISOString(),
    };
    try {
        await delivery.event({ kind: 'channel', id: channel.user_id, stream: live && live.id ? live.id : null },
            { type: 'element-state', ...payload }, { key: `element-state:${row.public_id}:${payload.revision}` });
    } catch { /* Chat's ingress may be off in development */ }
    try {
        streamEvents.init();
        await db.getDb().tx(async () => {
            await streamEvents.enqueue({
                event_type: 'live.element.state',
                actor: { type: 'service', id: 'live' },
                subject: { type: 'element', id: row.public_id },
                visibility: 'public', priority: 'low', payload,
            });
        });
        streamEvents.kick();
    } catch { /* durable event only when the outbox is on */ }
}

/** One press from the deck (POST /api/channels/:name/elements/:id/press). */
async function fromPress({ channel, presser, id }) {
    const found = await store.byPublicId(channel.user_id, id);
    if (!found) return refuse('not_found', 'That element does not exist.');
    if (!found.element.active) return refuse('not_active', 'That element is not on the deck.');
    return await run({
        channel, presser, row: found.row, element: found.element,
        trigger: { trigger: { kind: 'press' }, hints: {} }, source: 'press',
    });
}

/** A chat command from Chat's existing /internal/chat-effects/chat-message effect. */
async function fromChat({ channelUserId, user, text }) {
    // Stage 1 takes commands from signed-in people only: it needs a subject for points, roles and
    // the pressed event, and a bot's own system line must never trigger another element.
    if (!user || !user.id) return [];
    const command = String(text || '').trim().split(/\s+/)[0].toLowerCase();
    if (!/^![a-z0-9_-]{1,32}$/.test(command)) return [];
    const channel = await db.get('SELECT c.*, u.username, u.display_name FROM channels c JOIN users u ON u.id = c.user_id WHERE c.user_id = ?', [channelUserId]);
    if (!channel || !Number(channel.deck_enabled)) return [];
    const byCommand = await store.chatCommands(channel.user_id);
    const rows = byCommand.get(command) || [];
    if (!rows.length) return [];
    const presser = await db.getUserById(user.id);
    if (!presser) return [];
    const out = [];
    for (const row of rows) {
        const element = store.shape(row, await db.get('SELECT revision, values FROM element_state WHERE element_id = ?', [row.id]));
        try {
            out.push({ element_id: row.public_id, ...(await run({
                channel, presser, row, element,
                trigger: { trigger: { kind: 'chat_command', command }, hints: { isStreamer: !!user.isStreamer, isMod: !!user.isMod } },
                source: 'chat',
            })) });
        } catch (e) {
            out.push({ element_id: row.public_id, ok: false, code: 'error', message: 'The element could not run.' });
        }
    }
    return out;
}

module.exports = { run, fromPress, fromChat, roleOf, costOf, STATUS };
