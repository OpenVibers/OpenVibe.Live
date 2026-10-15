'use strict';
/**
 * The go-live setup hub's finished tasks, recorded once per person, and live.setup.task_completed for each one
 * (openvibe-contracts 0.190.0). OpenVibe.Quest turns every task into a quest (owner Q16: Live's setup steps become
 * quests), so finishing "Upload a custom emote" here completes the matching quest there.
 *
 * GET /api/streams/setup-progress works the tasks out (server/streaming/routes.js) and hands them to record(). A task
 * that reads as done and has no live_setup_tasks row yet gets one, and its event is queued in Live's outbox in the
 * same transaction, so the row and the event commit together. A task is recorded at most once: the primary key
 * (user_id, task) makes a second request that raced this one insert nothing and queue nothing.
 *
 * Nothing is recorded for a person Live cannot name on the network (no linked subject yet): the next visit tries
 * again, so the quest is not lost. The event says which task it was and how far along the person is, never what
 * they made.
 *
 *   envelope  subject { type: 'user', id: usr_… } (the streamer), actor the same, visibility internal
 *   payload   { task, user: { type: 'user', id }, title, group, completed_at, done, total }
 */
const db = require('../db/database');
const identity = require('../auth/identity-sync');
const streamEvents = require('../events/stream-events');

const EVENT_TYPE = 'live.setup.task_completed';

function toIso(v) {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Record the newly finished tasks of `tasks` (the hub's list: { id, group, title, done }) for `userId`.
 * Returns the ids it recorded now (empty when nothing was new).
 */
async function record(userId, tasks) {
    const finished = (tasks || []).filter((t) => t && t.done);
    if (!finished.length) return [];
    const known = new Set((await db.all('SELECT task FROM live_setup_tasks WHERE user_id = ?', [userId])).map((r) => r.task));
    const fresh = finished.filter((t) => !known.has(t.id));
    if (!fresh.length) return [];
    const subjectId = await identity.subjectOf(userId);
    if (!subjectId) return [];
    const person = { type: 'user', id: subjectId };
    const recorded = [];
    await db.tx(async () => {
        for (const t of fresh) {
            const row = await db.get('INSERT INTO live_setup_tasks (user_id, task) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING completed_at', [userId, t.id]);
            if (!row) continue;   // another request recorded it first, and queued its event
            recorded.push(t.id);
            await streamEvents.enqueue({
                event_type: EVENT_TYPE,
                actor: person,
                subject: person,
                visibility: 'internal',
                priority: 'low',
                payload: {
                    task: t.id,
                    user: person,
                    title: String(t.title || '').slice(0, 120),
                    group: String(t.group || '').slice(0, 40),
                    completed_at: toIso(row.completed_at),
                    done: finished.length,
                    total: tasks.length,
                },
            });
        }
    });
    if (recorded.length) streamEvents.kick();
    return recorded;
}

module.exports = { EVENT_TYPE, record };
