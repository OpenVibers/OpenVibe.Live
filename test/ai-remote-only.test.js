'use strict';
/**
 * Live calls no model provider itself and keeps no shared provider key (roadmap WS-O task 2, shims
 * C-20 and C-21). Against a stub Network (token endpoint), a stub OpenVibe.AI and a stub "provider"
 * that must never be reached, with every outbound connection and fetch recorded:
 *   - AI off (AI_SERVICE=off, or the admin switch ai_enabled off): every AI entry point answers null
 *     (or its template / "no AI" value) and nothing at all goes out;
 *   - AI on: llm.complete only ever talks to OpenVibe.AI, for the site's AI and for a streamer's key
 *     stored there; a raw key / base URL override answers null with one warning and its address is
 *     never contacted; a streamer's key typed but not saved is tested through the egress guard;
 *   - the shared-key settings are not seeded, and a leftover ai_api_key row is deleted at boot;
 *   - no file in server/ builds a provider request except llm.testProvider.
 *
 *   node test/ai-remote-only.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-ai-remote-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.AI_SERVICE = 'off';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };

// ── Every connection and fetch this process makes ──
const outbound = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    outbound.push(o && typeof o === 'object' ? `${o.host || o.path || '?'}:${o.port || ''}` : String(o));
    return realConnect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { outbound.push(`fetch ${url}`); return realFetch(url, opts); };

// ── Stubs: Network (service tokens), OpenVibe.AI (runs), a provider nobody may call ──
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw);
        const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.run.create', 'ai.run.read'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), token_type: 'Bearer', expires_in: 300 }));
    });
});
const aiRuns = [];
const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        aiRuns.push(body);
        const output = body.workflow === 'live.translate' ? { text: 'hello everyone', unchanged: false }
            : body.workflow === 'live.paste.summarize_text' ? { description: 'A shopping list.' }
                : { text: 'ok from AI', json: null };
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ run: { id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: body.workflow }, output, usage: { tokens_in: 12, tokens_out: 3, cost_usd: 0.0002 }, provenance: { model: 'gpt-5-nano' } } }));
    });
});
const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4';   // the streamer's Network subject
let providerHits = 0;
const provider = http.createServer((req, res) => { providerHits++; res.setHeader('Content-Type', 'application/json'); res.end('{"choices":[{"message":{"content":"direct"}}]}'); });

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 4).join('\n      ')); }
}

(async () => {
    for (const s of [network, ai, provider]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    const aiService = require('../server/ai/ai-service');
    const llm = require('../server/ai/llm');
    const analysis = require('../server/ai/ai-analysis');
    const translate = require('../server/i18n/translate');
    const recap = require('../server/recap/recap');
    const budget = require('../server/ai/viewers/budget');
    const arena = require('../server/arena/arena-service');
    const media = require('../server/media-client');
    media.listVods = async () => ({ vods: [] });
    media.listClips = async () => ({ clips: [] });

    d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (40, 'kai', 'Kai', '$sso$')").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (40, 'network', '400', 'kai', ?)").run(SUBJECT);
    db.ensureChannel(40);
    const ch = db.getChannelByUserId(40);
    const sid = Number(db.createStream({ user_id: 40, channel_id: ch.id, title: 'Soldering at night', protocol: 'webrtc' }).lastInsertRowid);
    db.addStreamMemory({ stream_id: sid, user_id: 40, offset_seconds: 60, description: 'Kai solders a board' });
    db.endStream(sid);
    d.prepare('UPDATE streams SET duration_seconds = 3600 WHERE id = ?').run(sid);
    const frame = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(400, 'A')}`;

    quiet('AI is remote only');

    await check('the shared-key settings are not seeded, and a leftover ai_api_key row is deleted at boot', () => {
        const keysNow = d.prepare("SELECT key FROM site_settings WHERE key LIKE 'ai\\_%' ESCAPE '\\'").all().map((r) => r.key);
        for (const k of ['ai_api_key', 'ai_provider', 'ai_base_url', 'ai_model', 'ai_model_chat', 'ai_pricing_json', 'ai_input_cost_per_mtok']) assert.ok(!keysNow.includes(k), `${k} is seeded`);
        assert.ok(keysNow.includes('ai_enabled') && keysNow.includes('ai_max_cost_usd_per_day'));
        db.setSetting('ai_api_key', 'sentinel-not-a-secret-leftover');
        db.initDb();
        assert.strictEqual(db.getSettingRow('ai_api_key'), undefined);
    });

    // Both switches: AI_SERVICE=off with the admin switch on, then the admin switch off with AI_SERVICE on.
    for (const [label, setup] of [
        ['AI_SERVICE=off', () => { process.env.AI_SERVICE = 'OFF'; db.setSetting('ai_enabled', 'true'); }],
        ['ai_enabled off', () => { delete process.env.AI_SERVICE; db.setSetting('ai_enabled', 'false'); }],
    ]) {
        await check(`${label}: every AI entry point answers null (or no AI) and nothing goes out`, async () => {
            setup();
            db.upsertChannelAiConfig(40, { enabled: 1, use_shared_key: 1 });
            outbound.length = 0;
            assert.strictEqual(llm.isEnabled(), false);
            assert.strictEqual(await llm.complete({ role: 'chat', kind: 'chat_global', user: 'hi' }), null);
            assert.strictEqual(await analysis.analyzeImagePaste(frame, 'a screenshot'), null);
            assert.strictEqual(await analysis.analyzeTextPaste('eggs, milk, bread', 'list'), null);
            assert.strictEqual(await analysis.analyzeStreamFrame(frame), null);
            assert.strictEqual(await analysis.summarizeStreamMemories([{ description: 'Kai solders a board' }], sid), null);
            assert.strictEqual(await analysis.generateStreamerOverview(40), null);
            assert.strictEqual(await analysis.summarizeText('say something', 50, 'chat_global'), null);
            assert.strictEqual(await analysis.viewerComplete({ user: 'hi', ownerUserId: 40 }), null);
            assert.strictEqual(await analysis.generateVodOverview({ id: 1, stream_id: sid }), null);
            assert.strictEqual(await analysis.generateClipOverview({ id: 1, stream_id: sid }), null);
            assert.strictEqual((await analysis.testStatus({ probe: true })).ok, false);
            assert.strictEqual(await translate.translate('みなさんこんにちは', { from: 'ja', to: 'en' }), null);
            assert.deepStrictEqual(await translate.translateLines(['みなさん'], { from: 'ja' }), [null]);
            assert.strictEqual(await budget.generate(40, { user: 'hi' }), null);
            const r = await recap.buildRecap(sid);
            assert.ok(r && r.write && r.write.headline, 'the template report still ships');
            assert.strictEqual(r.ai, false);
            assert.strictEqual(arena.imageGenAvailable(), false);
            assert.strictEqual(await arena.generateImage(40), null, 'no portrait is drawn');
            if (label === 'AI_SERVICE=off') {
                // A streamer's key in OpenVibe.AI is not used either while the service is off.
                assert.strictEqual(await llm.complete({ role: 'chat', user: 'hi', provider: { credentialSubject: SUBJECT } }), null);
                assert.strictEqual(await aiService.structured('live.translate', { text: 'x', to: 'en' }), null);
            }
            assert.deepStrictEqual(outbound, [], 'nothing went out');
        });
    }

    await check('media analysis: a recording with speech gets no overview while AI is off, and nothing goes out', async () => {
        const wav = path.join(tmp, 'speech.wav');
        const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', wav], { stdio: 'ignore' });
        if (made.status !== 0 || !fs.existsSync(wav)) { quiet('    (ffmpeg unavailable: skipped)'); return; }
        const transcribe = require('../server/ai/transcribe');
        transcribe.available = () => true;
        transcribe.transcribeMediaDetailed = async () => ({ text: 'welcome back everyone', segments: [{ start: 0, end: 1, text: 'welcome back everyone' }], ok: true });
        process.env.AI_SERVICE = 'off';
        db.setSetting('ai_enabled', 'true');
        outbound.length = 0;
        const r = await require('../server/ai/media-analysis').analyzeMedia(wav, { userId: 40 });
        assert.strictEqual(r.transcript, 'welcome back everyone', 'the local transcript is kept');
        assert.strictEqual(r.overview, null);
        assert.deepStrictEqual(outbound, []);
    });

    await check('AI on: llm.complete is a run on OpenVibe.AI, metered as openvibe-ai; structured analyses and translation too', async () => {
        delete process.env.AI_SERVICE;
        db.setSetting('ai_enabled', 'true');
        assert.strictEqual(aiService.enabled(), true, 'on unless AI_SERVICE=off');
        process.env.AI_SERVICE = 'remote';
        assert.strictEqual(aiService.enabled(), true, 'the old value still means on');
        outbound.length = 0; aiRuns.length = 0;
        const r = await llm.complete({ role: 'chat', kind: 'chat_global', source: 'chat_ai', user: 'sum up chat', ownerUserId: 40 });
        assert.strictEqual(r.text, 'ok from AI');
        assert.strictEqual(r.provider, 'openvibe-ai');
        assert.strictEqual(aiRuns[0].workflow, 'live.chat.insight');
        const row = d.prepare("SELECT provider, owner_user_id, kind FROM ai_usage ORDER BY id DESC LIMIT 1").get();
        assert.deepStrictEqual([row.provider, row.owner_user_id, row.kind], ['openvibe-ai', 40, 'chat_global']);
        assert.deepStrictEqual(await analysis.analyzeTextPaste('eggs, milk, bread', 'list'), { description: 'A shopping list.', tags: [] });
        assert.strictEqual(await translate.translate('みなさんこんばんは', { from: 'ja', to: 'en' }), 'hello everyone');
        assert.deepStrictEqual(aiRuns.map((x) => x.workflow), ['live.chat.insight', 'live.paste.summarize_text', 'live.translate']);
        const aiPorts = [String(ai.address().port), String(network.address().port)];
        assert.ok(outbound.some((o) => o.includes(`:${ai.address().port}`)), 'the recorder sees the calls to OpenVibe.AI');
        const elsewhere = outbound.filter((o) => !aiPorts.some((p) => o.endsWith(`:${p}`) || o.includes(`:${p}/`)));
        assert.deepStrictEqual(elsewhere, [], 'only OpenVibe.AI and the Network token endpoint were contacted');
    });

    await check('AI on: a streamer\'s key stored in OpenVibe.AI runs there with credential { subject }, metered as byo', async () => {
        aiRuns.length = 0;
        const r = await llm.complete({ role: 'chat', kind: 'ai_viewers', source: 'ai_viewers', user: 'hi', ownerUserId: 40, provider: { credentialSubject: SUBJECT } });
        assert.strictEqual(r.provider, 'byo');
        assert.deepStrictEqual(aiRuns[0].credential, { subject: SUBJECT });
        assert.strictEqual(d.prepare('SELECT provider FROM ai_usage ORDER BY id DESC LIMIT 1').get().provider, 'byo');
    });

    await check('AI on: a raw key / base URL override is never called and never falls back to the site\'s AI (one warning)', async () => {
        outbound.length = 0; aiRuns.length = 0; warnings.length = 0;
        assert.strictEqual(await llm.complete({ role: 'chat', user: 'hi', provider: { apiKey: 'sk-EXAMPLE-0000', baseUrl: providerUrl, model: 'm' } }), null);
        assert.strictEqual(await llm.complete({ role: 'chat', user: 'hi', provider: { baseUrl: providerUrl } }), null);
        assert.strictEqual(await llm.complete({ role: 'chat', user: 'hi', provider: { apiKey: 'sk-EXAMPLE-0000' } }), null);
        assert.strictEqual(providerHits, 0);
        assert.deepStrictEqual(outbound, [], 'not the provider, not OpenVibe.AI');
        assert.strictEqual(aiRuns.length, 0);
        assert.strictEqual(warnings.filter((w) => /raw provider key/.test(w)).length, 1, 'warned once');
        // Viewers of a channel whose key never moved to OpenVibe.AI stay quiet.
        db.upsertChannelAiConfig(40, { enabled: 1, use_shared_key: 0, byo_key: 'sk-EXAMPLE-0000', byo_base_url: providerUrl, byo_in_ai: 0 });
        assert.strictEqual(budget.budgetStatus(40).reason, 'no_byo_key');
        assert.strictEqual(await budget.generate(40, { user: 'hi' }), null);
        assert.strictEqual(providerHits, 0);
    });

    await check('a key typed but not saved is tested through the egress guard: an internal address is refused', async () => {
        const r = await llm.testProvider({ apiKey: 'sk-EXAMPLE-0000', baseUrl: providerUrl, model: 'gpt-4o-mini' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(providerHits, 0);
        assert.deepStrictEqual(await llm.testProvider({ baseUrl: '', apiKey: '' }), { ok: false, error: 'Enter your API key to test it' });
        assert.strictEqual((await llm.testProvider({ credentialSubject: 'usr_x' })).ok, false);
    });

    await check('no file in server/ builds a provider request except llm.testProvider', () => {
        const PROVIDER_CALL = /anthropic-version|chat\/completions|images\/(generations|edits)|audio\/transcriptions/;
        const root = path.join(__dirname, '..', 'server');
        const hits = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    let src = fs.readFileSync(f, 'utf8');
                    if (f.endsWith(path.join('ai', 'llm.js'))) {
                        const start = src.indexOf('async function testProvider(');
                        const end = src.indexOf('\n}\n', start);
                        assert.ok(start > 0 && end > start, 'llm.testProvider exists');
                        src = src.slice(0, start) + src.slice(end);
                    }
                    if (PROVIDER_CALL.test(src)) hits.push(path.relative(root, f));
                }
            }
        };
        walk(root);
        assert.deepStrictEqual(hits, []);
        const exported = Object.keys(llm).sort();
        for (const gone of ['resolveProvider', 'modelForRole', 'priceFor', 'estimateCost', 'defaultModel']) assert.ok(!exported.includes(gone), `llm.${gone} is gone`);
        assert.ok(!fs.existsSync(path.join(root, 'ai', 'ai-provider.js')), 'the unused direct client is gone');
    });

    for (const s of [network, ai, provider]) s.close();
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet(failures ? `\n${failures} check(s) failed` : '\nai remote only: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
