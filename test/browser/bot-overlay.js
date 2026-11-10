#!/usr/bin/env node
/**
 * The robot controls over the player: a real Chrome at 390×780 (phone upright), 844×390 (phone on its side)
 * and 1280×800. Needs a running site with a channel bound to a robot, and Chrome (not part of `npm test`).
 *
 *   BASE=https://openvibe.live CHANNEL=/@Maticus npm run test:bot-overlay
 *   OUT=/tmp/shots BASE=http://127.0.0.1:4188 CHANNEL=/@rover node test/browser/bot-overlay.js
 *
 * It forces the live area visible when the channel is offline (the same trick the deploy check uses), chooses
 * "Controls: on the video", then checks:
 *   - the overlay slot never reaches into the player's controls bar, unmute overlay or the chat fold button
 *     (the controls' z-index stays below all three);
 *   - the frame is clipped to the controls (a clip-path with at least one rectangle), so a press in the middle
 *     of the picture reaches the player instead of the transparent iframe;
 *   - the card under the player is the one line with "Show panel";
 *   - a screenshot at each size under OUT.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright');

const BASE = (process.env.BASE || 'https://openvibe.live').replace(/\/$/, '');
const CHANNEL = process.env.CHANNEL || '/@Maticus';
const OUT = process.env.OUT || '/home/workstation/openvibe/research-2026-11-10/controls-overlay';
const SIZES = [[390, 780, 'portrait'], [844, 390, 'landscape'], [1280, 800, 'desktop']];

async function forceLive(page) {
    await page.evaluate(() => {
        window.scrollTo(0, 0);
        const live = document.getElementById('ch-live-area');
        const off = document.getElementById('ch-offline-area');
        if (live) live.style.display = '';
        if (off) off.style.display = 'none';
        const channel = document.getElementById('page-channel');
        if (channel) channel.classList.add('ch-is-live');
        const v = document.getElementById('video-element');
        if (v) { v.style.display = 'block'; v.style.opacity = '1'; v.style.filter = 'none'; v.style.transform = 'none'; }
        const box = document.getElementById('video-container');
        if (box) box.style.background = '#0b0d12';
        // Offline there is no picture: the placeholder and its loader cover the player and eat the clicks.
        for (const el of document.querySelectorAll('#video-container .video-placeholder, #video-container [class*="player-placeholder"], #stream-switch-overlay, .ovld-host, #unmute-overlay')) {
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
        }
    });
}

async function pickOverlay(page) {
    const inline = page.locator('#ch-bot-mode-inline');
    await inline.waitFor({ state: 'visible', timeout: 20000 });
    const btn = page.locator('#ch-bot-mode-btn');
    if ((await btn.getAttribute('data-mode')) !== 'overlay') {
        await btn.click({ force: true });
        await page.locator('#ch-bot-mode-menu [data-bot-mode="overlay"]').click({ force: true });
    }
    await page.waitForFunction(() => {
        const slot = document.getElementById('ch-bot-overlay-slot');
        return slot && !slot.hidden && slot.querySelector('iframe');
    }, null, { timeout: 20000 });
    const frame = page.locator('#ch-bot-overlay-slot iframe');
    await frame.waitFor({ state: 'visible', timeout: 20000 });
    return frame;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
    const context = await browser.newContext();
    let failed = 0;
    for (const [width, height, name] of SIZES) {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.setViewportSize({ width, height });
        await page.goto(BASE + CHANNEL, { waitUntil: 'load' });
        await page.waitForTimeout(1500);
        try {
            await forceLive(page);
            await pickOverlay(page);
            await page.waitForTimeout(1200);
            const m = await page.evaluate(() => {
                const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
                const z = (el) => { if (!el) return null; const v = getComputedStyle(el).zIndex; return v === 'auto' ? 0 : Number(v) || 0; };
                const slot = document.getElementById('ch-bot-overlay-slot');
                const player = document.getElementById('video-container');
                const bar = player && player.querySelector('.video-overlay');
                const unmute = document.getElementById('unmute-overlay');
                const fold = document.getElementById('ch-chat-reopen');
                const frame = slot && slot.querySelector('iframe');
                return {
                    slot: rect(slot), player: rect(player), bar: rect(bar), unmute: rect(unmute), fold: fold && !fold.hidden ? rect(fold) : null,
                    zSlot: z(slot), zBar: z(bar), zUnmute: z(unmute), zFold: z(fold),
                    clip: frame ? (frame.style.clipPath || getComputedStyle(frame).clipPath) : null,
                    cardLine: (() => { const el = document.getElementById('ch-bot-card-line'); return el ? !el.hidden : false; })(),
                    cardFrame: !!document.querySelector('#ch-bot-container iframe'),
                };
            });
            assert.ok(m.slot && m.player, 'the player and its overlay slot are on the page');
            assert.ok(m.slot.bottom <= m.bar.top + 0.5, `the slot ends above the player's bar (slot ${m.slot.bottom} > bar ${m.bar.top})`);
            if (m.fold) assert.ok(m.slot.right <= m.fold.left || m.slot.left >= m.fold.right || m.slot.bottom <= m.fold.top || m.slot.top >= m.fold.bottom, 'the slot never covers the chat fold button');
            assert.ok(m.zSlot < m.zBar, `the slot stays under the player's bar (${m.zSlot} < ${m.zBar})`);
            if (m.unmute) assert.ok(m.zSlot < m.zUnmute, `and under the unmute pill (${m.zSlot} < ${m.zUnmute})`);
            if (m.fold && m.zFold != null) assert.ok(m.zSlot < m.zFold, `and under the chat fold button (${m.zSlot} < ${m.zFold})`);
            assert.ok(m.clip && /M\s*\d+\s+\d+/.test(m.clip), `the frame is clipped to its controls (${m.clip})`);
            assert.ok(m.cardLine && !m.cardFrame, 'the card under the player is the one-line state, not a second frame');
            // A press in the middle of the picture must reach the player, not the transparent frame.
            const cx = m.player.x + m.player.width / 2;
            const cy = m.player.y + m.player.height / 2;
            await page.evaluate(() => {
                window.__ovVideoClicks = 0;
                const player = document.getElementById('video-container');
                player.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('#ch-bot-overlay-slot')) window.__ovVideoClicks++; }, true);
            });
            const hit = await page.evaluate(([x, y]) => {
                const el = document.elementFromPoint(x, y);
                return { id: el && el.id, inSlot: !!(el && el.closest && el.closest('#ch-bot-overlay-slot')) };
            }, [cx, cy]);
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(250);
            const clicks = await page.evaluate(() => window.__ovVideoClicks || 0);
            assert.ok(!hit.inSlot, `the centre of the picture is not the overlay frame (element ${hit.id || '?'})`);
            assert.ok(clicks >= 1, 'a press outside the controls reaches the player');
            assert.deepStrictEqual(errors, [], `no page errors (${errors.join(' · ')})`);
            const shot = path.join(OUT, `bot-overlay-${width}x${height}-${name}.png`);
            await page.screenshot({ path: shot, fullPage: false });
            // The viewer's choice is remembered: a reload of the same channel and robot keeps the controls on the video
            // even though the streamer's default is under it.
            if (name === 'portrait') {
                await page.reload({ waitUntil: 'load' });
                await page.waitForTimeout(1200);
                await forceLive(page);
                await page.waitForFunction(() => {
                    const slot = document.getElementById('ch-bot-overlay-slot');
                    return slot && !slot.hidden && slot.querySelector('iframe');
                }, null, { timeout: 20000 });
                assert.strictEqual(await page.locator('#ch-bot-mode-btn').getAttribute('data-mode'), 'overlay', 'the viewer choice survives a reload');
            }
            console.log(`  ✓ ${width}×${height}: slot above the bar (${Math.round(m.bar.top - m.slot.bottom)} px clear), clipped, press passes through → ${shot}`);
        } catch (e) {
            failed++;
            console.log(`  ✗ ${width}×${height}: ${e.message}`);
            try { await page.screenshot({ path: path.join(OUT, `bot-overlay-${width}x${height}-${name}-fail.png`), fullPage: false }); } catch { /* */ }
        }
        await page.close();
    }
    await browser.close();
    if (failed) { console.log(`bot-overlay: ${failed} failed`); process.exit(1); }
    console.log('bot-overlay: all passed');
})();
