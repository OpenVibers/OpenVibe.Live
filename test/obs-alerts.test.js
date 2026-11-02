'use strict';
// The alerts overlay (plan L45 step 5): /obs/alerts/<username> shows a channel's moments (follow, tip, sub, raid, goal)
// from `overlay-alert` messages on its chat room, one at a time, in the look given by name. Every value from a message
// is text (a tipper's words can never be markup), ids are shown once, the queue is bounded, and demo=1 plays samples.
// The page runs here on a tiny DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/obs/alerts.html'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
const script = SRC.slice(SRC.lastIndexOf('<script>') + 8, SRC.lastIndexOf('</script>'));

// ── The route ──
const re = /^\/obs\/alerts\/[A-Za-z0-9_.-]{1,40}\/?$/;
assert.ok(index.includes(`app.get(${re.toString()}`), 'the alerts route');
assert.ok(re.test('/obs/alerts/goosely') && !re.test('/obs/alerts/<x>') && !re.test('/obs/alerts/'), 'a username only');

// ── The page, statically ──
assert.ok(!/innerHTML/.test(script), 'a message is only ever text');
assert.match(SRC, /background: transparent !important/, 'a transparent ground over the stream');
assert.match(SRC, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(script, /m\.type === 'overlay-alert'/, 'only overlay-alert messages');
assert.match(script, /type: 'join', streamId: streamId, channel: user/, 'joins the channel\'s room, live or not');

// ── The page, running on a tiny DOM ──
class N {
    constructor(t) { this.tagName = t; this.children = []; this.attrs = {}; this.className = ''; this._text = ''; this.style = {}; }
    append(...k) { k.forEach((c) => this.children.push(typeof c === 'string' ? Object.assign(new N('#t'), { _text: c }) : c)); }
    replaceChildren(...k) { this.children = []; this.append(...k); }
    replaceWith() {} remove() { this.removed = true; }
    setAttribute(k, v) { this.attrs[k] = String(v); } removeAttribute() {}
    get classList() { const n = this; return { add: (c) => { n.className += ` ${c}`; } }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40 }; }
}
function run(href) {
    const ids = { 'al-stage': new N('div'), 'al-status': new N('p') };
    const timers = [];
    const sockets = [];
    const confetti = [];
    const u = new URL(href);
    const sandbox = {
        location: { pathname: u.pathname, search: u.search, protocol: 'https:', host: 'openvibe.live', reload() {} },
        URLSearchParams, Set, Number, String, Object, JSON, Math, Date,
        document: { getElementById: (id) => ids[id], createElement: (t) => new N(t), documentElement: new N('html'), body: new N('body') },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        setInterval: () => 0,
        fetch: async () => ({ ok: true, json: async () => ({ channel: { username: 'goosely' }, stream: { id: 7 } }) }),
        WebSocket: class { constructor(url) { this.url = url; this.sent = []; sockets.push(this); } send(m) { this.sent.push(JSON.parse(m)); } close() {} },
    };
    sandbox.window = sandbox;
    sandbox.OVFx = { confetti: (o) => confetti.push(o) };
    vm.runInNewContext(script, sandbox);
    const runTimers = (max = 50) => { for (let i = 0; i < max && timers.length; i++) timers.shift().fn(); };
    return { ids, sandbox, sockets, confetti, runTimers, timers };
}

(async () => {
    const p = run('https://openvibe.live/obs/alerts/goosely?theme=paper');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const ws = p.sockets[0];
    assert.ok(ws && ws.url === 'wss://openvibe.live/ws/chat?stream=7', 'the channel\'s chat room');
    ws.onopen();
    assert.deepStrictEqual(ws.sent[0], { type: 'join', streamId: 7, channel: 'goosely' });

    // A tip with words that try to be markup: shown as text.
    ws.onmessage({ data: JSON.stringify({ type: 'overlay-alert', kind: 'tip', id: 't1', who: { name: 'Wren', avatar: 'javascript:alert(1)' }, amount: { value: 25, unit: 'Vibes' }, text: '<img src=x onerror=alert(1)>' }) });
    const stage = p.ids['al-stage'];
    assert.match(stage.textContent, /^Wren/);
    assert.match(stage.textContent, /tipped 25 Vibes/);
    assert.ok(stage.textContent.includes('<img src=x onerror=alert(1)>'), 'the words, as words');
    const imgs = []; const walk = (n) => { if (n.tagName === 'img') imgs.push(n); n.children.forEach(walk); }; walk(stage);
    assert.strictEqual(imgs.length, 0, 'only an https avatar is shown');

    // The same id twice: shown once. Other messages: ignored.
    ws.onmessage({ data: JSON.stringify({ type: 'overlay-alert', kind: 'tip', id: 't1', who: { name: 'Wren' } }) });
    ws.onmessage({ data: JSON.stringify({ type: 'chat', message: 'hi' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'overlay-alert', kind: 'nonsense', id: 'x' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'overlay-alert', kind: 'follow', id: 'f1', who: { name: 'Goosely' } }) });
    p.runTimers();
    assert.match(stage.textContent, /Goosely.*followed/, 'next in line: the follow, once the tip has had its time');
    assert.ok(p.confetti.length >= 1, 'a tip of 10 or more throws confetti');

    // Demo mode plays samples without a channel or a socket.
    const d = run('https://openvibe.live/obs/alerts/goosely?demo=1');
    assert.strictEqual(d.sockets.length, 0);
    assert.match(d.ids['al-stage'].textContent, /Wren.*followed/);
    console.log('obs alerts: the channel room, text only, once per id, a queue, confetti for the big ones, a demo');
})().catch((e) => { console.error(e); process.exit(1); });
