'use strict';
/**
 * The agent's step (design 2026-11-07): an agent stream is one step of the agent's timeline — running while the desk
 * publishes, stopped when it ends. The payload is a title, an outcome and a link: never the task, a frame, a chat
 * line or a voice line.
 *
 *   node test/agent-step.test.js
 */
const assert = require('assert');
const { AGENT_TOPICS, agentStepOf, agentStepEnvelope, stepChangeOf, pageUrl } = require('../server/agent-streams/agent-step');

const ROW = {
    public_id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNPS',
    username: 'ada',
    title: 'Fixing the checkout tests',
    owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS',
    state: 'idle',
    started_at: null,
    task: { prompt: 'the desk task, which never leaves Live' },
    latest_step_title: 'running the tests',
};

assert.strictEqual(AGENT_TOPICS.started, 'agent.step.started');
assert.strictEqual(AGENT_TOPICS.ended, 'agent.step.ended');

const running = agentStepOf(ROW, { status: 'running', startedAt: 1762000000000, baseUrl: 'https://openvibe.live' });
assert.strictEqual(running.step_id, ROW.public_id);
assert.strictEqual(running.mode, 'stream');
assert.strictEqual(running.product, 'live');
assert.strictEqual(running.status, 'running');
assert.strictEqual(running.title, 'Streaming Fixing the checkout tests');
assert.strictEqual(running.link, 'https://openvibe.live/@ada/agents/ags_01JAB2C3D4E5F6G7H8J9K0MNPS');
assert.strictEqual(running.ended_at, null);
assert.ok(running.placement && running.placement.where && running.placement.why);
const raw = JSON.stringify(running);
assert.ok(!raw.includes('the desk task'), 'the task never travels');
assert.ok(!raw.includes('running the tests'), 'the desk steps never travel');
assert.ok(!('task' in running) && !('frames' in running) && !('chat' in running) && !('voice' in running), 'no field for the content');

const ended = agentStepOf(ROW, { status: 'stopped', startedAt: 1762000000000, endedAt: 1762000060000, reason: null });
assert.strictEqual(ended.status, 'stopped');
assert.ok(ended.ended_at, 'an ended stream says when it ended');
assert.strictEqual(agentStepOf(ROW, { status: 'stopped', reason: 'you ended it' }).reason, 'you ended it');

const start = stepChangeOf(ROW, { state: 'live' });
assert.strictEqual(start.topic, 'started');
assert.strictEqual(start.status, 'running');
assert.ok(start.startedAt, 'the step says when the stream started');
assert.strictEqual(stepChangeOf({ ...ROW, state: 'live' }, { state: 'live' }), null, 'a pause of a live stream is not a new step');
const stop = stepChangeOf({ ...ROW, state: 'live' }, { state: 'ended' }, { kind: 'ended', extra: { reason: 'ended' } });
assert.strictEqual(stop.topic, 'ended');
assert.strictEqual(stop.status, 'stopped');
assert.strictEqual(stop.reason, 'ended');
assert.ok(stop.endedAt, 'the step says when the stream ended');

const env = agentStepEnvelope(ROW, { topic: 'started', status: 'running', startedAt: 1762000000000 });
assert.strictEqual(env.event_type, 'agent.step.started');
assert.deepStrictEqual(env.subject, { type: 'user', id: ROW.owner_subject });
assert.strictEqual(env.visibility, 'internal');
assert.strictEqual(agentStepEnvelope({ ...ROW, owner_subject: null }, { topic: 'started', status: 'running' }), null, 'no subject, no step');
assert.strictEqual(pageUrl(ROW), 'https://openvibe.live/@ada/agents/' + ROW.public_id);
console.log('live agent step: one stream, one running step — never the task, a frame or a chat line');
console.log('all passed');
