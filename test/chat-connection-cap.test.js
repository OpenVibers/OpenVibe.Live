/**
 * Chat WebSocket per-address cap: one address cannot hold more than MAX_CHAT_SOCKETS_PER_IP
 * sockets, closing one frees a slot, and the count does not leak.
 *
 *   node test/chat-connection-cap.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-chatcap-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const WebSocket = require('ws');
const chat = require('../server/chat/chat-server');

const server = http.createServer();
chat.init(server);
server.on('upgrade', (req, socket, head) => { if (!chat.handleUpgrade(req, socket, head)) socket.destroy(); });

const open = (port, ip) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, { headers: { 'cf-connecting-ip': ip } });
    ws.on('open', () => {
        // The server closes over-cap sockets right after the upgrade; give it a tick to say so.
        const t = setTimeout(() => resolve({ ws, code: null }), 150);
        ws.on('close', (code) => { clearTimeout(t); resolve({ ws, code }); });
    });
    ws.on('error', () => resolve({ ws, code: -1 }));
});

server.listen(0, async () => {
    const port = server.address().port;
    let exit = 0;
    try {
        const held = [];
        for (let i = 0; i < 48; i++) {
            const r = await open(port, '203.0.113.7');
            assert.strictEqual(r.code, null, `socket ${i + 1} should stay open`);
            held.push(r.ws);
        }
        assert.strictEqual((await open(port, '203.0.113.7')).code, 4029, '49th socket from one address is refused');
        assert.strictEqual((await open(port, '198.51.100.9')).code, null, 'another address is unaffected');
        held.pop().close();
        await new Promise((r) => setTimeout(r, 150));
        const again = await open(port, '203.0.113.7');
        assert.strictEqual(again.code, null, 'closing a socket frees a slot');
        held.push(again.ws);
        held.forEach((w) => w.close());
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(chat._ipSockets.get('203.0.113.7') || 0, 0, 'count returns to zero');
        quiet('chat connection cap: all checks passed');
    } catch (e) {
        quiet('✗', e.message);
        exit = 1;
    }
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    process.exit(exit);
});
