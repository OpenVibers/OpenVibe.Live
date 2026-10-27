'use strict';
// A streamer's own provider key lives in OpenVibe.AI (roadmap WS-O task 2), against a stub Network (token
// endpoint) and a stub AI service:
//   - moveLocal sends a key still in Live's database to AI once (provider, address, models) and erases Live's copy;
//   - the streamer's AI viewers then run on AI with credential { subject }, metered here as 'byo', and never fall
//     back to the shared key (no subject → quiet);
//   - a model change keeps AI's stored key, a new address without the key is refused, byo_key null removes it.
//   node test/byo-credentials.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.AI_SERVICE = 'remote';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const LOCAL_KEY = 'sk-local-EXAMPLE-0000';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const calls = [];
const stored = new Map();
const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw);
        const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.run.create', 'ai.credential.manage'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), token_type: 'Bearer', expires_in: 300 }));
    });
});
const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        calls.push({ method: req.method, url: req.url, body });
        res.setHeader('Content-Type', 'application/json');
        const m = /^\/api\/v1\/credentials\/(usr_[0-9A-Z]+)$/.exec(req.url);
        if (m && req.method === 'PUT' && body.provider === 'node') {
            if (body.api_key || body.base_url || !/^(dev_[0-9A-Z]{26}|any)$/.test(body.machine || '')) { res.statusCode = 422; return res.end(JSON.stringify({ code: 'input.invalid' })); }
            stored.set(m[1], body);
            return res.end(JSON.stringify({ subject: m[1], owner: 'live', provider: 'node', machine: body.machine, models: body.models }));
        }
        if (m && req.method === 'PUT') {
            const prev = stored.get(m[1]);
            if (!body.api_key && (!prev || prev.base_url !== body.base_url)) { res.statusCode = 400; return res.end(JSON.stringify({ code: 'credential.key_required', detail: 'enter the key again' })); }
            stored.set(m[1], { ...body, api_key: body.api_key || prev.api_key });
            return res.end(JSON.stringify({ subject: m[1], owner: 'live', provider: body.provider, key_hint: '…0000' }));
        }
        if (m && req.method === 'DELETE') { stored.delete(m[1]); res.statusCode = 204; return res.end(); }
        if (req.url.startsWith('/api/v1/runs')) {
            res.statusCode = 201;
            return res.end(JSON.stringify({ run: { id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: 'live.viewers.line' }, output: { text: 'hi from the streamer key', json: null }, usage: { tokens_in: 10, tokens_out: 5, cost_usd: 0.0001 }, provenance: { model: 'gpt-4o-mini' } } }));
        }
        res.statusCode = 404; res.end('{}');
    });
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const db = require('../server/db/database');
    await db.initDb();
    const byo = require('../server/ai/byo-credentials');
    const budget = require('../server/ai/viewers/budget');
    const d = db.getDb();
    const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
    await d.prepare("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (30, 'dana', '$sso$'), (31, 'nolink', '$sso$')").run();
    await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (30, 'network', '300', 'dana', ?)").run(SUBJECT);
    await db.setSetting('ai_enabled', 'true');
    await db.upsertChannelAiConfig(30, { enabled: 1, use_shared_key: 0, byo_key: LOCAL_KEY, byo_base_url: 'https://openrouter.ai/api/v1', byo_model: 'gpt-4o-mini' });
    await db.upsertChannelAiConfig(31, { enabled: 1, use_shared_key: 0, byo_key: LOCAL_KEY });
    try {
        // ── The move ──
        assert.strictEqual(await byo.moveLocal(30), 'moved');
        const put = calls.find((c) => c.method === 'PUT');
        assert.deepStrictEqual([put.url, put.body.provider, put.body.base_url, put.body.api_key, put.body.models], [`/api/v1/credentials/${SUBJECT}`, 'openai', 'https://openrouter.ai/api/v1', LOCAL_KEY, { chat: 'gpt-4o-mini' }]);
        const cfg = await db.getChannelAiConfig(30);
        assert.deepStrictEqual([cfg.byo_key, cfg.byo_in_ai], ['', 1], "Live's copy is erased");
        assert.strictEqual(await byo.moveLocal(30), 'none', 'moving again changes nothing');
        assert.strictEqual(await byo.moveLocal(31), 'credentials.no_subject', 'no Network account: the key stays until one is linked');

        // ── The viewers run on AI with the credential ──
        const n = calls.length;
        const director = require('../server/ai/viewers/director');
        const reply = await director.quickReply({ stableText: 'roster', situationText: '', bot: { username: 'goosebot' }, streamerLine: 'say hi', provider: await budget.byoProvider(await db.getChannelAiConfig(30)), ownerUserId: 30 });
        assert.strictEqual(reply.text, 'hi from the streamer key');
        const runCall = calls.slice(n).find((c) => c.url.startsWith('/api/v1/runs'));
        assert.deepStrictEqual([runCall.body.workflow, runCall.body.credential], ['live.viewers.reply', { subject: SUBJECT }]);
        assert.ok(!JSON.stringify(runCall.body).includes(LOCAL_KEY), 'the key is not in the run');
        const usage = await d.prepare("SELECT provider, owner_user_id FROM ai_usage WHERE source = 'ai_viewers' ORDER BY id DESC LIMIT 1").get();
        assert.deepStrictEqual([usage.provider, usage.owner_user_id], ['byo', 30], 'metered as the streamer\'s own');
        // A key in AI without a subject never falls back to the shared key.
        await db.upsertChannelAiConfig(31, { byo_key: '', byo_in_ai: 1 });
        const m = calls.length;
        assert.strictEqual(await director.quickReply({ stableText: 's', situationText: '', bot: { username: 'b' }, streamerLine: 'x', provider: await budget.byoProvider(await db.getChannelAiConfig(31)) || { none: true }, ownerUserId: 31 }), null);
        assert.strictEqual(calls.length, m, 'nothing was called');

        // ── Saving the config ──
        let fields = { byo_model: 'gpt-4o' };
        assert.strictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), undefined, fields), null);
        const modelPut = calls[calls.length - 1];
        assert.deepStrictEqual([modelPut.method, modelPut.body.api_key, modelPut.body.models.chat], ['PUT', undefined, 'gpt-4o'], 'a model change keeps the stored key');
        fields = { byo_base_url: 'https://attacker.example/v1' };
        const refused = await byo.applyConfig(30, await db.getChannelAiConfig(30), undefined, fields);
        assert.deepStrictEqual([refused.status, refused.code], [400, 'credential.key_required'], 'a new address needs the key again');
        fields = {};
        assert.strictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), 'sk-new-EXAMPLE-1111', fields), null);
        assert.deepStrictEqual([fields.byo_key, fields.byo_in_ai], ['', 1], 'a new key is never saved in Live');
        fields = {};
        assert.strictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), null, fields), null);
        assert.deepStrictEqual([calls[calls.length - 1].method, fields.byo_in_ai], ['DELETE', 0]);
        assert.ok(!stored.has(SUBJECT));

        // ── A model on the streamer's own computer (provider node): the machine, no key, no address ──
        const MACHINE = 'dev_01M5YGM39VC2RRGDQPRD6D4SHD';
        fields = { byo_model: 'llama3.1:8b', byo_base_url: '' };
        assert.deepStrictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), undefined, fields, { provider: 'node', machine: 'nope' }).then((r) => r && r.code), 'credentials.machine', 'a computer named');
        fields = { byo_model: 'llama3.1:8b', byo_base_url: '' };
        assert.strictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), undefined, fields, { provider: 'node', machine: MACHINE }), null);
        const nodePut = calls[calls.length - 1];
        assert.deepStrictEqual([nodePut.method, nodePut.body], ['PUT', { provider: 'node', machine: MACHINE, models: { chat: 'llama3.1:8b' } }], 'no key, no address');
        assert.deepStrictEqual([fields.byo_key, fields.byo_in_ai], ['', 1]);
        await db.upsertChannelAiConfig(30, { ...fields, use_shared_key: 0 });
        await require('../server/ai/viewers/settings').updateSettings(30, { byo: { provider: 'node', machine: 'any' } });
        assert.strictEqual(byo.providerOf(await db.getChannelAiConfig(30)), 'node');
        assert.strictEqual(byo.machineOf(await db.getChannelAiConfig(30)), 'any', 'any of their computers is kept');
        // A model change keeps the computer; the viewers run on AI with the credential as before.
        fields = { byo_model: 'qwen2.5:7b' };
        assert.strictEqual(await byo.applyConfig(30, await db.getChannelAiConfig(30), undefined, fields), null);
        assert.deepStrictEqual(calls[calls.length - 1].body, { provider: 'node', machine: 'any', models: { chat: 'qwen2.5:7b' } });
        const k = calls.length;
        const fromComputer = await director.quickReply({ stableText: 'roster', situationText: '', bot: { username: 'goosebot' }, streamerLine: 'say hi', provider: await budget.byoProvider(await db.getChannelAiConfig(30)), ownerUserId: 30 });
        assert.ok(fromComputer && fromComputer.text, 'an answer');
        assert.deepStrictEqual(calls.slice(k).find((c) => c.url.startsWith('/api/v1/runs')).body.credential, { subject: SUBJECT });
        // The dashboard (public/js/ai-viewers.js, public/fragments/dashboard.html): the third source and what it saves.
        const fs = require('fs');
        const path = require('path');
        const ui = fs.readFileSync(path.join(__dirname, '../public/js/ai-viewers.js'), 'utf8');
        assert.ok(ui.includes("body.settings.byo = { provider: 'node', machine,") && ui.includes("? 'any' :"), 'computer mode saves provider node with the machine or any');
        assert.ok(ui.includes("onComputer ? 'computer'"), 'and loads back as computer mode');
        const frag = fs.readFileSync(path.join(__dirname, '../public/fragments/dashboard.html'), 'utf8');
        assert.ok(frag.includes('<option value="computer">A model on my own computer (free)</option>') && frag.includes('id="aiv-node-machine"') && frag.includes('id="aiv-node-any"'));
    } finally {
        network.close(); ai.close();
    }
    console.log('byo credentials: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
