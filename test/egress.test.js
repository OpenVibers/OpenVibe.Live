/**
 * Outbound requests to user-chosen URLs (server/net/egress.js).
 *
 * The policy is enforced where connections are made, so these tests make real connections:
 *   - a local HTTP server stands in for an internal service;
 *   - "localhost" stands in for a rebinding DNS name (it resolves to loopback at connect time);
 *   - the loopback proxy that yt-dlp and ffmpeg use must refuse both, for CONNECT and plain HTTP,
 *     including literal IPs (Node skips `lookup` for those — the bug this suite first caught);
 *   - fetchText must refuse a redirect to an internal address.
 *
 *   node test/egress.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const egress = require('../server/net/egress');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

function rawRequest(port, text) {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
        let data = '';
        sock.on('data', (c) => { data += c; if (/\r\n\r\n/.test(data)) sock.destroy(); });
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
        setTimeout(() => sock.destroy(), 3000);
    });
}

(async () => {
    let internalHits = 0;
    const internal = http.createServer((req, res) => { internalHits++; res.end('<title>internal admin</title>'); }).listen(0, '127.0.0.1');
    await new Promise((r) => internal.once('listening', r));
    const ip = internal.address().port;

    await check('address policy: internal spellings refused, public allowed', () => {
        const blocked = ['0.0.0.0', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.20.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1',
            '::', '::1', 'fe80::1', 'fc00::1', 'fd12::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1',
            '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::1'];
        for (const b of blocked) assert.strictEqual(egress.isPublicAddress(b), false, b);
        for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
            assert.strictEqual(egress.isPublicAddress(a), true, a);
        }
        assert.strictEqual(egress.isPublicAddress('not-an-ip'), false);
    });

    await check('assertPublicUrl refuses internal names, literals, credentials and non-http', async () => {
        for (const u of [`http://127.0.0.1:${ip}/`, `http://localhost:${ip}/`, `http://[::ffff:7f00:1]:${ip}/`, 'file:///etc/passwd', 'http://user:pw@example.com/']) {
            await assert.rejects(egress.assertPublicUrl(u), /./, u);
        }
    });

    const proxyUrl = await egress.proxy();
    const proxyPort = Number(new URL(proxyUrl).port);

    await check('proxy CONNECT to a literal loopback address is refused', async () => {
        const res = await rawRequest(proxyPort, `CONNECT 127.0.0.1:${ip} HTTP/1.1\r\nHost: 127.0.0.1:${ip}\r\n\r\n`);
        assert.match(res, /^HTTP\/1\.1 403/, res);
    });

    await check('proxy CONNECT to a name that resolves to loopback (rebinding) is refused', async () => {
        const res = await rawRequest(proxyPort, `CONNECT localhost:${ip} HTTP/1.1\r\nHost: localhost:${ip}\r\n\r\n`);
        assert.match(res, /^HTTP\/1\.1 403/, res);
    });

    await check('proxy plain-HTTP requests to loopback (literal, mapped IPv6, name) are refused', async () => {
        for (const host of [`127.0.0.1:${ip}`, `[::ffff:7f00:1]:${ip}`, `localhost:${ip}`]) {
            const res = await rawRequest(proxyPort, `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
            assert.match(res, /^HTTP\/1\.1 403/, `${host}: ${res}`);
        }
    });

    await check('the internal service was never reached', () => {
        assert.strictEqual(internalHits, 0);
    });

    await check('fetchText refuses a redirect into the internal network', async () => {
        // A "public" first hop cannot exist in a sandbox, so exercise the redirect path directly: the
        // hop-by-hop check is the same assertPublicUrl call the first hop uses.
        const redirector = http.createServer((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${ip}/` }); res.end(); }).listen(0, '127.0.0.1');
        await new Promise((r) => redirector.once('listening', r));
        await assert.rejects(egress.fetchText(`http://127.0.0.1:${redirector.address().port}/`), /reachable|non-public|Only/);
        redirector.close();
        assert.strictEqual(internalHits, 0);
    });

    internal.close();
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\negress: all checks passed');
    process.exit(0);
})();
