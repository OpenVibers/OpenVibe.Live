/**
 * The channel page's OpenVibe.Bot robot panel (roadmap T15 R9, public/js/bot-embed.js).
 *
 * (a) iframeAttrs/mount on a tiny fake DOM: the sim.rover embed yields one sandboxed iframe, a new url
 *     replaces it, the same url keeps it, and javascript:/data:/plain-http/non-embed/missing urls show nothing.
 * (b) End to end with the real routers on a temp database: flag on + a channel bound to a sim.rover robot →
 *     the channel GET carries the url the iframe uses; flag off → no bot_embed, and the page code
 *     (app-channel.js's _applyBotEmbed, run against a fake ov) requests nothing and adds nothing.
 * (c) The dashboard's binding card (dashboard.js) shows only with the flag on, saves, unbinds and shows server errors.
 * (d) Drive from the framed panel (Maticus, 2026-10-26: driving took a popup and a second sign-in): listen() answers
 *     the panel's ticket request and refusal only from that frame and Bot's origin, for this robot; and
 *     POST /api/streams/channel/:username/bot/ticket asks Bot (a stub) for a ticket as the viewer, for the channel's
 *     own robot only, saying Bot's refusal in plain words.
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
        assert.strictEqual((app.match(/_applyBotEmbed\(/g) || []).length, 3, 'defined once, called for the channel and after binding');
        assert.ok(app.includes('_applyBotEmbed(data.bot_embed, username);'));
        assert.ok(app.includes('onBound: (be) => _applyBotEmbed(be, username)'));
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
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const call = (method, p, body, user = '1') => new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = user ? { 'x-test-user': user } : {};
        if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, body: json, text, headers: res.headers }); });
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
        const env = { BotEmbed: undefined, _botEmbedStop: null, currentUser: null, api: async () => ({}), document: { getElementById: (id) => (id === 'ch-bot-container' ? dom.container : null) } };
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
        const fn = src.match(/\nfunction _applyBotEmbed\(botEmbed, username\) \{[\s\S]*?\n\}\n/)[0];
        // eslint-disable-next-line no-new-func
        new Function('env', 'botEmbed', `with (env) { ${fn}; _applyBotEmbed(botEmbed, 'rover'); }`)(p.env, botEmbed);
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

        await check('listen(): the panel\'s ticket request is answered to Bot\'s origin; refusals and strangers are not', async () => {
            const listeners = new Set();
            const win = { addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) };
            const posted = [];
            const panel = { postMessage: (msg, origin) => posted.push([msg, origin]) };
            const frame = { contentWindow: panel };
            let answer = { ticket: 'T'.repeat(43) };
            let asked = 0;
            let refused = 0;
            const stop = BotEmbed.listen({ frame, botEmbed: SIM, win, requestTicket: async () => { asked++; return answer; }, onRefused: () => { refused++; } });
            const send = async (data, { origin = 'https://openvibe.bot', source = panel } = {}) => {
                for (const f of [...listeners]) await f({ data, origin, source });
            };
            await send({ type: 'ov-bot-ticket-request', robot_id: 'rob_sim123' }, { origin: 'https://evil.example' });
            await send({ type: 'ov-bot-ticket-request', robot_id: 'rob_sim123' }, { source: {} });
            await send({ type: 'ov-bot-ticket-request', robot_id: 'rob_other' });
            assert.strictEqual(asked, 0, 'another origin, another window or another robot is ignored');
            await send({ type: 'ov-bot-ticket-request', robot_id: 'rob_sim123' });
            assert.deepStrictEqual(posted.at(-1), [{ robot_id: 'rob_sim123', type: 'ov-bot-ticket', ticket: 'T'.repeat(43) }, 'https://openvibe.bot']);
            answer = { message: 'Sign in on OpenVibe.Live to drive the robot.' };
            await send({ type: 'ov-bot-ticket-request', robot_id: 'rob_sim123' });
            assert.deepStrictEqual(posted.at(-1)[0], { robot_id: 'rob_sim123', type: 'ov-bot-ticket-none', message: 'Sign in on OpenVibe.Live to drive the robot.' });
            await send({ type: 'ov-bot-embed-refused', robot_id: 'rob_sim123' }, { origin: 'https://evil.example' });
            assert.strictEqual(refused, 0);
            await send({ type: 'ov-bot-embed-refused', robot_id: 'rob_sim123' });
            assert.strictEqual(refused, 1);
            stop();
            assert.strictEqual(listeners.size, 0, 'stop() removes the listener');
            assert.strictEqual(typeof BotEmbed.listen({ frame, botEmbed: { url: 'javascript:alert(1)' }, win, requestTicket: async () => ({}) }), 'function');
            assert.strictEqual(listeners.size, 0, 'nothing listens for a url it would not frame');
        });

        await check('listen(): while the panel drives, the keys it names and the gamepad go to it; never typing, never after', async () => {
            const on = {};
            const add = (t, f) => { (on[t] = on[t] || new Set()).add(f); };
            const del = (t, f) => { if (on[t]) on[t].delete(f); };
            let rafs = [];
            let pads = [];
            const doc = { hidden: false, hasFocus: () => true, addEventListener: add, removeEventListener: del };
            const win = { addEventListener: add, removeEventListener: del, document: doc, navigator: { getGamepads: () => pads },
                requestAnimationFrame: (f) => { rafs.push(f); return rafs.length; }, cancelAnimationFrame: () => { rafs = []; } };
            const posted = [];
            const panel = { postMessage: (msg) => posted.push(msg) };
            const stop = BotEmbed.listen({ frame: { contentWindow: panel }, botEmbed: SIM, win, requestTicket: async () => ({}) });
            const msg = async (data, origin = 'https://openvibe.bot') => { for (const f of [...(on.message || [])]) await f({ data, origin, source: panel }); };
            const key = (type, code, extra = {}) => {
                const e = { code, key: extra.key || code, target: extra.target || { tagName: 'BODY' }, prevented: false, stopped: false,
                    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
                for (const f of [...(on[type] || [])]) f(e);
                return e;
            };
            assert.ok(!(on.keydown && on.keydown.size), 'nothing listens to keys before the panel drives');
            await msg({ type: 'ov-bot-controls', robot_id: 'rob_sim123', active: true, keys: ['KeyW', 'KeyA', 'Space', 'f'], pad: true }, 'https://evil.example');
            assert.ok(!(on.keydown && on.keydown.size), 'only Bot\'s origin turns it on');
            await msg({ type: 'ov-bot-controls', robot_id: 'rob_sim123', active: true, keys: ['KeyW', 'KeyA', 'Space', 'f'], pad: true });
            const w = key('keydown', 'KeyW', { key: 'w' });
            assert.ok(w.prevented && w.stopped, 'a key it takes is kept from the player');
            assert.deepStrictEqual(posted.at(-1), { robot_id: 'rob_sim123', type: 'ov-bot-key', code: 'KeyW', key: 'w', down: true, repeat: false });
            const n = posted.length;
            const chat = key('keydown', 'KeyA', { key: 'a', target: { tagName: 'TEXTAREA' } });
            key('keydown', 'KeyA', { key: 'a', target: { tagName: 'DIV', isContentEditable: true } });
            key('keydown', 'KeyA', { key: 'a', ctrlKey: true });
            const other = key('keydown', 'KeyM', { key: 'm' });
            assert.strictEqual(posted.length, n, 'never typing, never with a modifier, never a key it did not name');
            assert.ok(!chat.prevented && !other.prevented, 'and those keys stay the page\'s');
            key('keydown', 'KeyF', { key: 'F' });
            assert.deepStrictEqual([posted.at(-1).code, posted.at(-1).down], ['KeyF', true], 'a button key matches by its letter');
            key('keyup', 'KeyW', { key: 'w' });
            assert.deepStrictEqual([posted.at(-1).code, posted.at(-1).down], ['KeyW', false]);
            for (const f of [...on.blur]) f();
            assert.deepStrictEqual([posted.at(-1).code, posted.at(-1).down], ['KeyF', false], 'leaving the window lets go of what is held');
            // The gamepad: its state goes to the panel while this window is in front.
            pads = [{ connected: true, axes: [0, -1, 0.1234, 0], buttons: [{ pressed: true }, { pressed: false }] }];
            for (const f of [...on.gamepadconnected]) f();
            assert.strictEqual(rafs.length, 1, 'polling starts');
            rafs.shift()();
            assert.deepStrictEqual(posted.at(-1), { robot_id: 'rob_sim123', type: 'ov-bot-pad', axes: [0, -1, 0.123, 0], buttons: [true, false] });
            // Another state for a key it did not name changes nothing; a narrower list lets go of a key no longer named.
            key('keydown', 'KeyA', { key: 'a' });
            await msg({ type: 'ov-bot-controls', robot_id: 'rob_sim123', active: true, keys: ['KeyW'], pad: false });
            assert.deepStrictEqual([posted.at(-1).code, posted.at(-1).down], ['KeyA', false]);
            // The drive ends: what is held goes up, and nothing listens any more.
            key('keydown', 'KeyW', { key: 'w' });
            await msg({ type: 'ov-bot-controls', robot_id: 'rob_sim123', active: false, keys: [] });
            assert.deepStrictEqual([posted.at(-1).code, posted.at(-1).down], ['KeyW', false]);
            assert.ok(!on.keydown.size && !on.keyup.size && !on.blur.size && !on.gamepadconnected.size && !on.visibilitychange.size);
            assert.ok(!key('keydown', 'KeyW').prevented, 'the player has its keys back');
            await msg({ type: 'ov-bot-controls', robot_id: 'rob_sim123', active: true, keys: ['KeyW'] });
            stop();
            assert.ok(!on.keydown.size && !on.message.size, 'stop() removes every listener');
        });

        await check('POST …/bot/ticket: a Drive ticket from Bot as the viewer, for the channel\'s own robot only', async () => {
            const seen = [];
            let reply = { status: 200, body: { ticket: 'K'.repeat(43), robot_id: 'rob_sim123', role: 'queue', expires_in: 120 } };
            const stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => {
                    res.setHeader('Content-Type', 'application/json');
                    if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'live-bot-token', token_type: 'Bearer', expires_in: 300 }));
                    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, subject: req.headers['x-ov-subject'] });
                    res.statusCode = reply.status;
                    res.end(JSON.stringify(reply.body));
                });
            });
            await new Promise((r) => stub.listen(0, '127.0.0.1', r));
            const stubUrl = `http://127.0.0.1:${stub.address().port}`;
            const ENV = ['OV_OAUTH_CLIENT_SECRET', 'OV_NETWORK_INTERNAL_URL', 'LIVE_BOT_INTERNAL_URL'];
            const before = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
            Object.assign(process.env, { OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_NETWORK_INTERNAL_URL: stubUrl, LIVE_BOT_INTERNAL_URL: stubUrl });
            const ticket = (body, user) => call('POST', '/api/streams/channel/rover/bot/ticket', body, user);
            try {
                delete process.env.LIVE_BOT_EMBED;
                assert.strictEqual((await ticket({ robot_id: 'rob_sim123' })).status, 404, 'flag off: no such route');
                process.env.LIVE_BOT_EMBED = '1';
                assert.strictEqual((await ticket({ robot_id: 'rob_sim123' }, null)).status, 401, 'signed in only');
                assert.strictEqual((await ticket({ robot_id: 'rob_other1' })).status, 404, 'not the channel\'s robot');
                assert.strictEqual((await ticket({ robot_id: 'rob_sim123' })).status, 409, 'no Network subject linked');
                await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '901', 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ')").run();
                const ok = await ticket({ robot_id: 'rob_sim123' });
                assert.strictEqual(ok.status, 200, ok.text);
                assert.deepStrictEqual(ok.body, { ticket: 'K'.repeat(43), robot_id: 'rob_sim123', role: 'queue', expires_in: 120 });
                assert.strictEqual(ok.headers['cache-control'], 'no-store');
                assert.deepStrictEqual(seen.at(-1), { url: '/api/v1/robots/rob_sim123/control-ticket', method: 'POST', auth: 'Bearer live-bot-token', subject: 'usr_01J9ZZZZZZZZZZZZZZZZZZZZZZ' });
                reply = { status: 403, body: { code: 'bot.not_an_operator', detail: 'the owner decides who may drive this robot' } };
                const no = await ticket({ robot_id: 'rob_sim123' });
                assert.deepStrictEqual([no.status, no.body.code, no.body.error], [403, 'bot.not_an_operator', 'The robot\'s owner decides who may drive it.']);
                reply = { status: 503, body: {} };
                assert.strictEqual((await ticket({ robot_id: 'rob_sim123' })).status, 503, 'Bot down is said so');
            } finally {
                stub.close();
                await raw.prepare("DELETE FROM linked_accounts WHERE user_id = 1 AND service_user_id = '901'").run();
                for (const k of ENV) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
            }
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
