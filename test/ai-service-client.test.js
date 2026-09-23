'use strict';

// AI_SERVICE=remote (roadmap Wave 13): Live's AI goes to OpenVibe.AI as workflow runs with a service
// token for audience openvibe.ai. Against a stub Network (token endpoint) and a stub AI service:
// off by default; structured workflows return their output; llm.complete()-shaped calls become
// passthrough runs of the workflow that owns the feature, attributed to the streamer; synthetic
// (stub-provider) answers, failed runs, quota refusals and an unreachable service are all "no
// answer" (null); a still-running run is polled; a rejected token is refreshed once.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
delete process.env.AI_SERVICE;

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let tokenCalls = 0;
const calls = [];
const script = { next: [] };   // queued responses for the AI stub: { status, body } | function

const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        tokenCalls++;
        const f = new URLSearchParams(raw);
        const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.run.create', 'ai.run.read'], iat: now, exp: now + 300, jti: `tok_${tokenCalls}abcdefgh` }, keys.privateKey), expires_in: 300 }));
    });
});

const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const auth = String(req.headers.authorization || '');
        const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: keys.publicKey, audience: 'openvibe.ai' });
        const body = raw ? JSON.parse(raw) : null;
        calls.push({ method: req.method, url: req.url, body, tokenOk: v.ok, jti: v.ok ? v.claims.jti : null });
        let out = script.next.shift() || { status: 500, body: { code: 'unscripted' } };
        if (typeof out === 'function') out = out(body, req);
        res.statusCode = out.status;
        res.setHeader('Content-Type', 'application/json');
        if (out.headers) for (const [k, val] of Object.entries(out.headers)) res.setHeader(k, val);
        res.end(JSON.stringify(out.body));
    });
});

const run = (over = {}) => ({ id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: 'live.translate', version: 1 }, output: { text: 'hello everyone', unchanged: false }, provenance: { model: 'gpt-5-nano', provider: 'shared' }, usage: { tokens_in: 30, tokens_out: 5, cost_usd: 0.0001 }, ...over });

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const svc = require('../server/ai/ai-service');
    const metered = [];
    svc.setRecorder((r, m) => metered.push({ run: r.id, ...m }));

    // 0. Off by default: nothing is sent.
    assert.strictEqual(svc.enabled(), false);
    assert.strictEqual(await svc.structured('live.translate', { text: 'x', to: 'en' }), null);
    assert.strictEqual(calls.length, 0, 'default behaviour unchanged: no calls to OpenVibe.AI');

    process.env.AI_SERVICE = 'remote';
    assert.strictEqual(svc.enabled(), true);

    // 1. A structured workflow: token for openvibe.ai, the run's output back, usage metered for the streamer.
    script.next.push({ status: 201, body: { run: run() } });
    const out = await svc.structured('live.translate', { text: 'みなさん', from: 'ja', to: 'en' }, { meter: { kind: 'translate', ownerUserId: 42 } });
    assert.deepStrictEqual(out, { text: 'hello everyone', unchanged: false });
    const c1 = calls.pop();
    assert.ok(c1.tokenOk, 'Live calls with a service token for audience openvibe.ai');
    assert.strictEqual(c1.method, 'POST');
    assert.match(c1.url, /^\/api\/v1\/runs\?wait=\d+$/);
    assert.strictEqual(c1.body.workflow, 'live.translate');
    assert.deepStrictEqual(c1.body.attribution, { service: 'live', type: 'user', id: '42' });
    assert.deepStrictEqual(metered.pop(), { run: run().id, kind: 'translate', ownerUserId: 42 });

    // 2. Synthetic (stub provider), failed runs, quota refusals and an unreachable service are "no answer".
    script.next.push({ status: 201, body: { run: run({ synthetic: true }) } });
    assert.strictEqual(await svc.structured('live.translate', { text: 'a b', to: 'en' }, { meter: { kind: 'translate' } }), null);
    assert.strictEqual(metered.length, 0, 'synthetic output is not metered');
    script.next.push({ status: 201, body: { run: run({ status: 'failed', output: null, error: { code: 'provider.unavailable' } }) } });
    assert.strictEqual(await svc.structured('live.translate', { text: 'a b', to: 'en' }), null);
    script.next.push({ status: 429, headers: { 'Retry-After': '30' }, body: { code: 'quota.exceeded', detail: 'quota exceeded' } });
    assert.strictEqual(await svc.structured('live.translate', { text: 'a b', to: 'en' }), null);
    const saved = process.env.OV_AI_INTERNAL_URL;
    process.env.OV_AI_INTERNAL_URL = 'http://127.0.0.1:1';
    assert.strictEqual(await svc.structured('live.translate', { text: 'a b', to: 'en' }), null);
    process.env.OV_AI_INTERNAL_URL = saved;

    // 3. Still running after the wait: poll the run until it finishes.
    script.next.push({ status: 202, body: { run: run({ status: 'running', output: null }) } });
    script.next.push({ status: 200, body: { run: run({ status: 'running', output: null }) } });
    script.next.push({ status: 200, body: { run: run() } });
    calls.length = 0;
    assert.deepStrictEqual(await svc.structured('live.translate', { text: 'a b', to: 'en' }, { waitMs: 5000 }), run().output);
    assert.deepStrictEqual(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
    assert.strictEqual(calls[1].url, `/api/v1/runs/${run().id}`);

    // 4. A rejected token is refreshed once and the call retried.
    const before = tokenCalls;
    script.next.push({ status: 401, body: { code: 'token.expired' } });
    script.next.push({ status: 201, body: { run: run() } });
    calls.length = 0;
    assert.ok(await svc.structured('live.translate', { text: 'a b', to: 'en' }));
    assert.strictEqual(tokenCalls, before + 1, 'a new token was fetched');
    assert.notStrictEqual(calls[0].jti, calls[1].jti);

    // 5. llm.complete()-shaped calls: passthrough run of the owning workflow, llm.complete result shape back.
    script.next.push((body) => ({ status: 201, body: { run: run({ workflow: { key: body.workflow, version: 1 }, output: { text: '{"skip":true,"lines":[]}', json: { skip: true, lines: [] } }, provenance: { model: 'gpt-5' } }) } }));
    calls.length = 0;
    const r = await svc.complete({
        role: 'director', kind: 'ai_viewers_director', source: 'ai_viewers', ownerUserId: 7,
        system: [{ text: 'RULES', cache: true }, { text: '' }], user: 'plan now', json: { name: 'plan', schema: { type: 'object' }, strict: true }, maxTokens: 330, temperature: 0.9, cacheKey: 'chan:7',
    });
    const sent = calls[0].body;
    assert.strictEqual(sent.workflow, 'live.viewers.plan');
    assert.deepStrictEqual(sent.input.system, [{ text: 'RULES', cache: true }]);
    assert.strictEqual(sent.input.role, 'director');
    assert.strictEqual(sent.input.user, 'plan now');
    assert.strictEqual(sent.input.max_tokens, 330);
    assert.deepStrictEqual(sent.input.json.schema, { type: 'object' });
    assert.deepStrictEqual(sent.attribution, { service: 'live', type: 'user', id: '7' });
    assert.deepStrictEqual(r.json, { skip: true, lines: [] });
    assert.strictEqual(r.model, 'gpt-5');
    assert.deepStrictEqual(r.usage, { input: 30, output: 5, cached: 0 });
    assert.strictEqual(r.provider, 'openvibe-ai');
    assert.strictEqual(svc.workflowFor('something_new'), 'live.complete', 'unknown kinds still have a workflow');

    // 6. Images: OpenVibe.Media URLs are passed as URLs; anything else is downscaled here and sent inline.
    assert.deepStrictEqual(await svc.imageInput('https://openvibe.media/t/9', {}), { url: 'https://openvibe.media/t/9', max_width: 1024 });
    const inline = await svc.imageInput('/tmp/frame.jpg', { toVisionJpeg: async () => 'data:image/jpeg;base64,AAAA', maxWidth: 768 });
    assert.deepStrictEqual(inline, { data_url: 'data:image/jpeg;base64,AAAA', max_width: 768 });
    assert.strictEqual(await svc.imageInput('https://evil.example/x.png', { toVisionJpeg: async () => null }), null, 'other URLs are not forwarded');

    network.close();
    ai.close();
    console.log('ai service client: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
