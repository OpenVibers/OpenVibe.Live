/**
 * Voice channels (Maticus, 2026-10-20: "shows me as anon in the list and the full pop out is chopped").
 *
 * - /ws/call is OpenVibe.Chat's. It signs a browser's socket in from the socket's first auth-update message, never
 *   from the cookie or a token in the URL; call.js sent none on open, so every signed-in person joined as an anon
 *   number. _connectCallWs now sends the token as the first message and keeps it out of the URL (proxy logs).
 * - In a call, the in-call panel shares the sidebar with the channel list: the list keeps its rows and the panel
 *   scrolls, its controls held at the bottom (on a laptop the panel pushed the list out of sight and was cut off).
 *
 *   node test/voice-channels-signin.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const callSrc = read('public/js/call.js');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

/** Opens a call socket the way the page does and returns { url, sent } once it is open. */
function connect(token) {
    const sockets = [];
    class FakeWebSocket {
        constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() {}
    }
    FakeWebSocket.OPEN = 1;
    const ctx = {
        WebSocket: FakeWebSocket,
        location: { protocol: 'https:', host: 'openvibe.live' },
        document: { cookie: token ? `ov_token=${token}` : '' },
        callState: { channelId: 'public', streamId: null, peers: new Map(), ws: null, reconnectTimer: null },
        CALL_WS_MAX_BUFFERED_AMOUNT: 1 << 20,
        _getAuthToken: () => token,
        _closePeer() {}, _handleCallMessage() {}, _setConnState() {},
        clearTimeout, setTimeout, console, JSON, Math,
    };
    vm.createContext(ctx);
    vm.runInContext(`${extract(callSrc, '_sendCallMsg')}\n${extract(callSrc, '_connectCallWs')}\n_connectCallWs();`, ctx);
    const ws = sockets[0];
    ws.readyState = 1;
    ws.onopen();
    return { url: ws.url, sent: ws.sent };
}

const signedIn = connect('net.jwt.token');
assert.deepStrictEqual(signedIn.sent[0], { type: 'auth-update', token: 'net.jwt.token' }, 'the first message signs the socket in');
assert.strictEqual(signedIn.url, 'wss://openvibe.live/ws/call?channelId=public', 'no token in the URL (Chat ignores it; proxies log it)');

const anonymous = connect(null);
assert.deepStrictEqual(anonymous.sent, [], 'a signed-out visitor sends nothing and joins as an anon number');
assert.ok(!/token=\$\{encodeURIComponent\(token\)\}/.test(extract(callSrc, '_connectCallWs')));

// The in-call panel and the channel list share the sidebar instead of the panel crowding the list out.
const css = read('public/css/features/chatpage.css');
const rule = (sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `${sel} has a rule`);
    return css.slice(at, css.indexOf('}', at));
};
const panel = rule('.vc-connected-panel');
assert.match(panel, /flex: 0 1 auto;/);
assert.match(panel, /min-height: 0;/);
assert.match(panel, /overflow-y: auto;/);
assert.match(rule('.vc-connected-panel > *'), /flex-shrink: 0;/, 'the panel scrolls as a whole; its grid does not collapse');
assert.match(rule('.vc-sidebar:has(> .vc-connected-panel.is-open) .vc-channel-list'), /min-height: 112px;/, 'the list keeps a few rows in a call');
const controls = rule('.vc-connected-panel .vc-controls');
assert.match(controls, /position: sticky;/);
assert.match(controls, /bottom: 0;/);
assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.vc-sidebar:has\(> \.vc-connected-panel\.is-open\) \{ max-height: 45vh; max-height: 45dvh; overflow: hidden; \}/);

// Every way out of a call takes the panel's is-open off, so the in-call layout ends with it.
const vc = read('public/js/voice-channels.js');
const hides = vc.match(/connPanel\.style\.display = 'none'[^\n]*/g) || [];
assert.ok(hides.length >= 3);
for (const line of hides) assert.match(line, /classList\.remove\('is-open'\)/, line);

console.log('voice channels: signed in on open, panel and list share the sidebar — all checks passed');
