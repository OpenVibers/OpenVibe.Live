/**
 * The channel page's OpenVibe.Bot robot panel (roadmap T15 R9, public/js/bot-embed.js).
 *
 * (a) iframeAttrs/mount on a tiny fake DOM: the sim.rover embed yields one sandboxed iframe, a new url
 *     replaces it, the same url keeps it, and javascript:/data:/plain-http/non-embed/missing urls show nothing.
 * (b) End to end with the real routers on a temp database: flag on + a channel bound to a sim.rover robot →
 *     the channel GET carries the url the iframe uses; flag off → no bot_embed, and the page code
 *     (app-channel.js's _applyBotEmbed, run against a fake ov) requests nothing and adds nothing.
 * (c) The dashboard's binding card (dashboard.js) shows only with the flag on, saves, unbinds and shows server errors.
 *
 *   node test/bot-embed-page.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
delete process.env.LIVE_BOT_EMBED;
delete process.env.LIVE_BOT_URL;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const BotEmbed = require('../public/js/bot-embed.js');

const SIM = { enabled: true, robot_id: 'rob_sim123', url: 'https://openvibe.bot/panel/rob_sim123/embed' };
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms';

// Just enough DOM for mount(): elements with attributes, children, hidden and a section parent.
function fakeDom() {
    const doc = {
        created: 0,
        createElement(tag) {
            doc.created++;
            const attrs = {};
            return {
                tagName: tag.toUpperCase(), ownerDocument: doc, attrs,
                setAttribute(k, v) { attrs[k] = String(v); },
                getAttribute(k) { return k in attrs ? attrs[k] : null; },
            };
        },
    };
    const section = { hidden: true };
    const container = {
        ownerDocument: doc, parentNode: section, children: [],
        get firstChild() { return this.children[0] || null; },
        replaceChildren(...nodes) { this.children = nodes; },
        closest(sel) { return sel === 'section' ? section : null; },
    };
    return { doc, section, container };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    await check('iframeAttrs: the sim.rover embed gives the exact iframe attributes', () => {
        assert.deepStrictEqual(BotEmbed.iframeAttrs(SIM), {
            src: 'https://openvibe.bot/panel/rob_sim123/embed',
            title: 'Robot control panel',
            loading: 'lazy',
            referrerpolicy: 'strict-origin-when-cross-origin',
            allow: 'gamepad',
            sandbox: SANDBOX,
        });
        assert.strictEqual(BotEmbed.iframeAttrs({ url: 'http://localhost:3020/panel/rob_sim123/embed' }).src,
            'http://localhost:3020/panel/rob_sim123/embed', 'http://localhost is allowed for development');
    });

    await check('iframeAttrs: bad, unsafe and missing urls give null', () => {
        const bad = [undefined, null, {}, { enabled: true, robot_id: null, url: null }, { url: '' }, { url: 42 },
            { url: 'javascript:alert(1)//embed' }, { url: 'data:text/html,<b>x</b>/embed' },
            { url: 'http://evil.example/panel/rob_sim123/embed' }, { url: 'https://openvibe.bot/panel/rob_sim123' },
            { url: 'https://openvibe.bot/panel/rob_sim123/embed/x' }, { url: 'https://u:p@openvibe.bot/panel/rob_sim123/embed' },
            { url: '//openvibe.bot/panel/rob_sim123/embed' }, { url: 'not a url' }];
        assert.deepStrictEqual(bad.map((b) => BotEmbed.iframeAttrs(b)), bad.map(() => null));
    });

    await check('mount: one iframe with the embed src, section shown; same url keeps it, a new url replaces it', () => {
        const { doc, section, container } = fakeDom();
        const f1 = BotEmbed.mount(container, SIM);
        assert.strictEqual(container.children.length, 1);
        assert.strictEqual(f1.tagName, 'IFRAME');
        assert.strictEqual(f1.getAttribute('src'), SIM.url);
        assert.strictEqual(f1.getAttribute('sandbox'), SANDBOX);
        assert.strictEqual(f1.getAttribute('allow'), 'gamepad');
        assert.strictEqual(f1.getAttribute('title'), 'Robot control panel');
        assert.strictEqual(section.hidden, false);
        assert.strictEqual(BotEmbed.mount(container, SIM), f1, 'a refresh keeps the frame (and its session)');
        assert.strictEqual(doc.created, 1);
        const other = { enabled: true, robot_id: 'rob_other1', url: 'https://openvibe.bot/panel/rob_other1/embed' };
        const f2 = BotEmbed.mount(container, other);
        assert.notStrictEqual(f2, f1);
        assert.deepStrictEqual(container.children, [f2]);
        assert.strictEqual(f2.getAttribute('src'), other.url);
    });

    await check('mount: unbound, absent or unsafe embeds remove the frame and hide the section', () => {
        for (const be of [undefined, { enabled: true, robot_id: null, url: null }, { url: 'javascript:alert(1)//embed' }, { url: 'http://evil.example/x/embed' }]) {
            const { doc, section, container } = fakeDom();
            BotEmbed.mount(container, SIM);
            assert.strictEqual(BotEmbed.mount(container, be), null);
            assert.deepStrictEqual(container.children, []);
            assert.strictEqual(section.hidden, true);
            assert.strictEqual(doc.created, 1);
        }
        assert.strictEqual(BotEmbed.mount(null, SIM), null, 'no container (another page) is a no-op');
    });

    await check('page wiring: the script is its own lazy feature and the section starts hidden', () => {
        const features = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'features.json'), 'utf8')).features;
        assert.deepStrictEqual(features.botEmbed.js, ['/js/bot-embed.js']);
        const everywhere = Object.entries(features).filter(([n, f]) => n !== 'botEmbed' && JSON.stringify(f).includes('bot-embed'));
        assert.deepStrictEqual(everywhere, [], 'no other feature pulls bot-embed.js in');
        const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        assert.ok(!index.includes('bot-embed'), 'the shell does not load it');
        const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8');
        assert.match(frag, /<section id="ch-bot-section"[^>]*\bhidden\b[^>]*>/);
        assert.match(frag, /<div id="ch-bot-container"><\/div>/);
        assert.ok(!/<iframe/i.test(frag), 'no iframe in the markup');
        const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
        assert.strictEqual((app.match(/_applyBotEmbed\(/g) || []).length, 2, 'defined once, called once');
        assert.ok(app.includes('_applyBotEmbed(data.bot_embed);'));
    });

    // ── (b) end to end through the real channel routes ──
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const auth = require('../server/auth/auth');
    const signIn = async (req) => {
        const id = Number(req.headers['x-test-user'] || 0);
        const u = id ? await db.getUserById(id) : null;
        if (u) { req.user = u; req.authSource = 'network'; }
        return u;
    };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };
    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE VALUES (1, 'rover', 'rover', 'rover@x', 'x', 'streamer')`).run();
    await db.ensureChannel(1);
    const chan = await db.getChannelByUserId(1);
    const moderation = require('../server/chat/moderation-client');
    moderation.getChannelModeration = async () => ({ settings: {}, moderator_ids: [] });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/bot/routes'));
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const call = (method, p, body) => new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = { 'x-test-user': '1' };
        if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, body: json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
    const channelGet = () => call('GET', '/api/streams/channel/rover?pollOnly=1');

    // The page side: _applyBotEmbed with a fake ov that records loads, and BotEmbed defined once "loaded".
    const page = () => {
        const dom = fakeDom();
        const loads = [];
        const env = { BotEmbed: undefined, document: { getElementById: (id) => (id === 'ch-bot-container' ? dom.container : null) } };
        const disposers = [];
        env.window = { ov: true };
        env.ov = {
            gen: () => 1, isCurrent: () => true,
            scope: () => ({ onDispose: (f) => disposers.push(f) }),
            load: (name) => { loads.push(name); env.BotEmbed = BotEmbed; return Promise.resolve(); },
        };
        return { dom, loads, env, disposers };
    };
    // app-channel.js's _applyBotEmbed run on its own; `with` lets it see the fake document/ov/BotEmbed globals.
    const runApply = (p, botEmbed) => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
        const fn = src.match(/\nfunction _applyBotEmbed\(botEmbed\) \{[\s\S]*?\n\}\n/)[0];
        // eslint-disable-next-line no-new-func
        new Function('env', 'botEmbed', `with (env) { ${fn}; _applyBotEmbed(botEmbed); }`)(p.env, botEmbed);
        return new Promise((r) => setImmediate(r));
    };

    try {
        await check('flag off: no bot_embed key, and the page loads nothing and adds no frame', async () => {
            await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_sim123', chan.id);
            const r = await channelGet();
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(!('bot_embed' in r.body));
            const p = page();
            await runApply(p, r.body.bot_embed);
            assert.deepStrictEqual(p.loads, [], 'no request for bot-embed.js');
            assert.deepStrictEqual(p.dom.container.children, []);
            assert.strictEqual(p.dom.section.hidden, true);
            assert.strictEqual(p.dom.doc.created, 0);
        });

        process.env.LIVE_BOT_EMBED = '1';

        await check('flag on, unbound: the page still loads nothing', async () => {
            assert.strictEqual((await call('PUT', '/api/streams/channel/rover/bot', { robot_id: null })).status, 200);
            const r = await channelGet();
            assert.deepStrictEqual(r.body.bot_embed, { enabled: true, robot_id: null, url: null });
            const p = page();
            await runApply(p, r.body.bot_embed);
            assert.deepStrictEqual(p.loads, []);
            assert.strictEqual(p.dom.section.hidden, true);
        });

        await check('flag on, bound to a sim.rover robot: the channel page renders the Bot panel iframe', async () => {
            const put = await call('PUT', '/api/streams/channel/rover/bot', { robot_id: 'rob_sim123' });
            assert.strictEqual(put.status, 200, put.text);
            const r = await channelGet();
            assert.deepStrictEqual(r.body.bot_embed, SIM);
            const p = page();
            await runApply(p, r.body.bot_embed);
            assert.deepStrictEqual(p.loads, ['botEmbed']);
            assert.strictEqual(p.dom.container.children.length, 1);
            const frame = p.dom.container.children[0];
            assert.strictEqual(frame.tagName, 'IFRAME');
            assert.strictEqual(frame.getAttribute('src'), 'https://openvibe.bot/panel/rob_sim123/embed');
            assert.strictEqual(frame.getAttribute('sandbox'), SANDBOX);
            assert.strictEqual(p.dom.section.hidden, false);
            assert.strictEqual(p.disposers.length, 1);
            p.disposers[0]();
            assert.deepStrictEqual(p.dom.container.children, [], 'leaving the route removes the frame');
            assert.strictEqual(p.dom.section.hidden, true);
        });

        // The dashboard's binding card (public/js/dashboard.js), run against the real routes through a fake api().
        const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
        const dashFns = ['loadBotEmbedSetting', 'saveBotEmbedSetting'].map((n) => {
            const m = dash.match(new RegExp(`\\nasync function ${n}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
            assert.ok(m, `${n} is in dashboard.js`);
            return m[0];
        }).join('\n');
        const dashboard = () => {
            const els = {
                'dash-card-bot-embed': { style: { display: 'none' } },
                'dash-bot-robot-id': { value: '' },
                'dash-bot-robot-status': { textContent: '' },
            };
            const env = {
                currentUser: { id: 1, username: 'rover' },
                document: { getElementById: (id) => els[id] || null },
                api: async (p, opts = {}) => {
                    const r = await call(opts.method || 'GET', `/api${p}`, opts.body);
                    if (r.status >= 400) throw { status: r.status, message: (r.body && r.body.error) || 'Request failed' };
                    return r.body;
                },
            };
            // eslint-disable-next-line no-new-func
            const fns = new Function('env', `with (env) { ${dashFns}; return { loadBotEmbedSetting, saveBotEmbedSetting }; }`)(env);
            return { els, ...fns };
        };

        await check('dashboard: the binding card shows the bound id and saves, unbinds and reports server errors', async () => {
            const d = dashboard();
            await d.loadBotEmbedSetting();
            assert.strictEqual(d.els['dash-card-bot-embed'].style.display, '');
            assert.strictEqual(d.els['dash-bot-robot-id'].value, 'rob_sim123');
            d.els['dash-bot-robot-id'].value = 'not-a-robot';
            await d.saveBotEmbedSetting();
            assert.strictEqual(d.els['dash-bot-robot-status'].textContent, 'robot_id must be a Bot robot id (rob_…) or null');
            assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, 'rob_sim123');
            d.els['dash-bot-robot-id'].value = '  ';
            await d.saveBotEmbedSetting();
            assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, null, 'an empty id unbinds');
            d.els['dash-bot-robot-id'].value = ' rob_sim123 ';
            await d.saveBotEmbedSetting();
            assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, 'rob_sim123');
            assert.strictEqual(d.els['dash-bot-robot-status'].textContent, 'Bound to rob_sim123');
        });

        await check('dashboard, flag off: the binding card stays hidden', async () => {
            delete process.env.LIVE_BOT_EMBED;
            const d = dashboard();
            await d.loadBotEmbedSetting();
            assert.strictEqual(d.els['dash-card-bot-embed'].style.display, 'none');
        });
    } finally {
        delete process.env.LIVE_BOT_EMBED;
        server.close();
    }

    if (failures) { console.log(`bot-embed-page: ${failures} failed`); process.exit(1); }
    console.log('bot-embed-page: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
