/**
 * Discovery files and asset caching on the real server (server/seo/discovery.js, openvibe-shared/seo
 * and openvibe-shared/cache-policy): /robots.txt, /sitemap.xml, /llms.txt and /llms-full.txt answer
 * from the shared builders, and a /shared/ file is immutable for a year only under its current ?v=.
 */
'use strict';
const assert = require('assert');
const crawl = require('./security-crawl');

const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

(async () => {
    const tmp = crawl.tempEnv('seo-discovery');
    let code = 1;
    try {
        const srv = await crawl.boot(tmp);
        const get = (p) => srv.request('GET', p, { timeoutMs: 8000 });
        quiet('seo discovery');

        await check('/robots.txt welcomes crawlers, names the AI bots and the sitemap', async () => {
            const r = await get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.ok(r.text.startsWith('User-agent: *\nAllow: /\n'), r.text.slice(0, 80));
            assert.ok(/^User-agent: GPTBot$/m.test(r.text) && /^User-agent: ClaudeBot$/m.test(r.text));
            assert.ok(r.text.includes('Sitemap: https://openvibe.live/sitemap.xml'));
            assert.strictEqual(r.headers['cache-control'], 'public, max-age=3600, stale-while-revalidate=3600');
        });

        await check('/sitemap.xml is a urlset of absolute openvibe.live URLs, with the docs and no /p/', async () => {
            const r = await get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^application\/xml/);
            assert.ok(r.text.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
            const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            for (const u of ['https://openvibe.live/', 'https://openvibe.live/content', 'https://openvibe.live/moments', 'https://openvibe.live/docs/whip']) {
                assert.ok(locs.includes(u), `missing ${u}`);
            }
            assert.ok(locs.every((u) => u.startsWith('https://openvibe.live/')), locs.join(' '));
            assert.ok(!locs.some((u) => u.includes('/p/')), 'pastes are Community\'s');
            assert.ok(r.text.includes('<loc>https://openvibe.live/</loc><changefreq>daily</changefreq><priority>1.0</priority>'));
            assert.strictEqual(r.headers['cache-control'], 'public, max-age=3600, stale-while-revalidate=3600');
        });

        await check('/llms.txt is an llmstxt.org map that links /llms-full.txt', async () => {
            const r = await get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Live\n\n> '));
            assert.ok(r.text.includes('[llms-full.txt](https://openvibe.live/llms-full.txt)'));
            assert.ok(r.text.includes('[robots.txt](https://openvibe.live/robots.txt)'));
        });

        await check('/llms-full.txt carries the docs themselves, under their own URLs', async () => {
            const r = await get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Live\n\n> '));
            assert.ok(r.text.includes('\nhttps://openvibe.live/docs/whip\n'), 'the WHIP doc section');
            assert.ok(r.text.includes('\nhttps://openvibe.live/docs/go-live-in-your-browser\n'));
            assert.ok(r.text.length > 5000, `only ${r.text.length} characters`);
            assert.ok(!/<html/i.test(r.text));
        });

        await check('a /shared/ file is immutable under its current ?v=, short-cached under any other', async () => {
            const assets = require('../server/web/assets');
            const v = assets.hashOf('/shared/shipped.js');
            assert.ok(v, 'shipped.js has a content hash');
            const current = await get(`/shared/shipped.js?v=${v}`);
            assert.strictEqual(current.status, 200);
            assert.strictEqual(current.headers['cache-control'], 'public, max-age=31536000, immutable');
            assert.strictEqual(current.headers['cdn-cache-control'], 'public, max-age=31536000, immutable');
            const wrong = await get(`/shared/shipped.js?v=${v === '0123456789ab' ? 'ba9876543210' : '0123456789ab'}`);
            assert.strictEqual(wrong.status, 200);
            assert.strictEqual(wrong.headers['cache-control'], 'public, max-age=300, stale-while-revalidate=86400');
            assert.strictEqual(wrong.headers['cdn-cache-control'], undefined);
        });
        code = failures ? 1 : 0;
    } catch (e) {
        quiet('  ✗ boot', e && e.stack);
    } finally {
        tmp.cleanup();
        quiet(code ? `\n${failures} check(s) failed` : '\nseo discovery: all checks passed');
        process.exit(code);
    }
})();
