'use strict';
// Minimal Chrome DevTools Protocol driver shared by the perf and smoke scripts.
// No Puppeteer/Playwright dependency: `ws` is already a production dependency.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function findChrome() {
    const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    return candidates.find((c) => c && fs.existsSync(c));
}

async function launch(opts = {}, attempt = 0) {
    try { return await launchOnce(opts); }
    catch (e) { if (attempt < 3) return launch(opts, attempt + 1); throw e; }
}

async function launchOnce({ width = 1366, height = 900, args = [] } = {}) {
    const bin = findChrome();
    if (!bin) throw new Error('Chrome not found (set CHROME_BIN)');
    // Random port: a collision with another Chrome just fails this attempt and launch() retries.
    const port = 9800 + Math.floor(Math.random() * 5000);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cdp-'));
    const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--no-first-run',
        `--user-data-dir=${profile}`, `--window-size=${width},${height}`, ...args, 'about:blank'], { stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 120; i++) {
        try { targets = await getJson(`http://127.0.0.1:${port}/json`); break; } catch { await sleep(250); }
    }
    if (!targets) { proc.kill('SIGKILL'); throw new Error('Chrome did not start'); }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        const fns = listeners.get(msg.method);
        if (fns) fns.forEach((fn) => fn(msg.params));
    });
    const send = (method, params = {}) => new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const on = (method, fn) => {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(fn);
    };
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) {
            const d = r.result.exceptionDetails;
            throw new Error((d.exception && d.exception.description) || d.text);
        }
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const close = () => {
        try { ws.close(); } catch { /* already closed */ }
        proc.kill('SIGKILL');
        setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500).unref();
    };
    return { send, on, evaluate, close };
}

// 412x900 phone: 4x CPU and a ~1.6Mbps link, the same profile used for the 2026-09-16 numbers.
async function emulatePhone(cdp, { network = true } = {}) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2.6, mobile: true });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // The local dev server does not compress responses (production sits behind Cloudflare, which
    // does), so network throttling against it measures uncompressed transfer. Use network: false
    // for local A/B runs and keep it for production.
    if (network) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
}

module.exports = { launch, emulatePhone, sleep };
