'use strict';
/**
 * Agent Streams S3: Live adds the stream part to the session report.
 *
 *   node test/session-report.test.js
 */
const assert = require('assert');
const { buildStreamReport } = require('../server/agent-streams/report');
const { createReportClient } = require('../server/report');

const OWNER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS';

(async () => {
    // The stream part of the report.
    const payload = buildStreamReport({
        public_id: 'ags_01JAN2C3D4E5F6G7H8J9K0MNPS',
        vod_id: 'vod_01JAN2C3D4E5F6G7H8J9K0MNPS',
        owner_subject: OWNER,
        title: 'The agent at work',
        visibility: 'public',
        task: { source: 'codes', ref: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS', title: 'Ship the checkout page', url: 'https://openvibe.codes/t/tsk_1' },
        started_at: '2026-11-06T18:00:00.000Z',
    }, { ended_at: '2026-11-06T18:42:00.000Z' }, 2520);
    assert.strictEqual(payload.ags_id, 'ags_01JAN2C3D4E5F6G7H8J9K0MNPS', 'the stream names itself');
    assert.strictEqual(payload.vod_id, 'vod_01JAN2C3D4E5F6G7H8J9K0MNPS', 'and the VOD it left behind');
    assert.strictEqual(payload.source, 'codes', 'the source is the one that ran the session');
    assert.strictEqual(payload.task_ref, 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS', 'the task ref matches the tool\'s report');
    assert.strictEqual(payload.owner, OWNER, 'the report is the person\'s');
    assert.strictEqual(payload.worked_seconds, 2520, '42 minutes of work');
    assert.strictEqual(payload.visibility, 'public', 'the stream\'s own visibility');

    // A stream of nobody\'s task still names its stream.
    const alone = buildStreamReport({ public_id: 'ags_01JAN2C3D4E5F6G7H8J9K0MNPS' }, null, 0);
    assert.strictEqual(alone.source, 'desk');
    assert.strictEqual(alone.task_ref, null, 'no tool finished it: a stream-only report');
    assert.strictEqual(alone.task.ref, 'ags_01JAN2C3D4E5F6G7H8J9K0MNPS');

    // The client: Live\'s own token for Report\'s audience, and the stream in the body.
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        if (String(url).includes('/oauth/token')) {
            return { ok: true, status: 200, json: async () => ({ access_token: 'the-service-token' }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: 'rps_01JAN2C3D4E5F6G7H8J9K0MNPS', url: 'https://openvibe.report/s/rps_1', created: false }) };
    };
    const client = createReportClient({
        config: { networkInternalUrl: 'http://127.0.0.1:4000', reportInternalUrl: 'http://127.0.0.1:5080', oauth: { clientId: 'live', clientSecret: 'the-secret' } },
        fetchImpl,
    });
    await client.sendStream(payload);
    const token = calls.find((c) => c.url.includes('/oauth/token'));
    assert.ok(token, 'Live asks Network for a token');
    assert.ok(String(token.opts.body).includes('audience=openvibe.report'), 'for Report\'s audience');
    assert.ok(String(token.opts.body).includes('scope=report.session.write'), 'with the report capability');
    const post = calls.find((c) => c.url.includes('/internal/session-reports/stream'));
    assert.ok(post, 'Live posts the stream to Report');
    assert.strictEqual(post.opts.method, 'POST');
    assert.strictEqual(post.opts.headers.Authorization, 'Bearer the-service-token');
    const sent = JSON.parse(post.opts.body);
    assert.strictEqual(sent.ags_id, 'ags_01JAN2C3D4E5F6G7H8J9K0MNPS', 'the stream part goes with it');

    console.log('  ✓ Live adds the stream part to the session report');
})().catch((e) => { console.error(e); process.exit(1); });
