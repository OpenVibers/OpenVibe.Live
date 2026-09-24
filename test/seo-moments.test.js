/**
 * AI Moments pages (server/seo/seo.js, roadmap §33.4 and §33.8): what the AI made from a stream is
 * labelled as AI-made, credited to no person, kept out of search and pointed at its source.
 *
 *   - An auto-clip (Media auto_generated), an AI moment paste (Community origin 'ai') and an
 *     AI-written after-show recap render noindex,follow, with the canonical on the source VOD at
 *     the moment (/vod/<id>?t=<s>) when that VOD is known and public, else on themselves.
 *   - Their structured data names no Person and no author; it says AI-generated and links the source.
 *   - People's clips and pastes keep index,follow, their own canonical and their author.
 *   - The sitemap lists people's clips only, even when the upstream ignores the filter.
 *
 * Media and Community are stubbed in-process; the database is a temp file.
 *
 *   node test/seo-moments.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `ov-seo-moments-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
delete process.env.PASTES_ON_COMMUNITY;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const addUser = (id, username, display) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', 'streamer', '2025-01-01 00:00:00')`).run(id, username, display, `${username}@x`);
addUser(3, 'alice', 'Alice');
addUser(4, 'bob', 'Bob');
db.ensureChannel(3);
const chan = db.getChannelByUserId(3);
const streamId = Number(db.createStream({ user_id: 3, channel_id: chan.id, title: 'Night stream', protocol: 'rtmp' }).lastInsertRowid);
db.endStream(streamId);
const quietStream = Number(db.createStream({ user_id: 3, channel_id: chan.id, title: 'Quiet stream', protocol: 'rtmp' }).lastInsertRowid);
db.endStream(quietStream);

// ── OpenVibe.Media and OpenVibe.Community stand-ins ──
const media = require('../server/media-client');
const missing = () => new media.MediaApiError('not found', 404, { error: 'not found' });
const VODS = {
    10: { id: 10, user_id: 3, stream_id: streamId, title: 'Night stream VOD', visibility: 'public', is_public: true, status: 'ready', duration_seconds: 3600 },
    11: { id: 11, user_id: 3, title: 'Private VOD', visibility: 'private', is_public: false, status: 'ready', duration_seconds: 60 },
};
const CLIPS = {
    20: { id: 20, user_id: 3, channel_user_id: 3, vod_id: 10, stream_id: streamId, title: 'Chat lost it', visibility: 'public', is_public: true, status: 'ready', auto_generated: true, start_time: 125.5, end_time: 150.5, duration_seconds: 25 },
    21: { id: 21, user_id: 4, channel_user_id: 3, vod_id: 10, title: 'Bob clipped this', visibility: 'public', is_public: true, status: 'ready', auto_generated: false, start_time: 40, duration_seconds: 20 },
    22: { id: 22, user_id: 3, channel_user_id: 3, vod_id: 11, title: 'AI clip of a private VOD', visibility: 'public', is_public: true, status: 'ready', auto_generated: true, start_time: 5, duration_seconds: 20 },
};
const clipQueries = [];
media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing(); return { ...v }; };
media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing(); return { ...c }; };
media.listVods = async (q = {}) => ({ vods: Object.values(VODS).filter((v) => v.is_public && (!q.stream_id || v.stream_id === q.stream_id)).slice(Number(q.offset) || 0, (Number(q.offset) || 0) + (Number(q.limit) || 50)) });
// Ignores auto_generated on purpose: the sitemap must not trust the filter alone.
media.listClips = async (q = {}) => { clipQueries.push(q); return { clips: (Number(q.offset) || 0) ? [] : Object.values(CLIPS) }; };
media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
const pastesClient = require('../server/pastes-client');
const PASTES = {
    'ai-shot': { slug: 'ai-shot', origin: 'ai', type: 'screenshot', title: 'Cat on the keyboard', visibility: 'public', stream_id: streamId, screenshot_url: 'https://media.test/s/1.jpg', ai_summary: 'A cat walks over the keyboard.', display_name: 'OpenVibe AI', username: null, metadata: JSON.stringify({ ai_moment: true, vod_id: 10, offset: 300, vod_link: '/vod/10?t=300', username: 'alice' }) },
    'ai-live': { slug: 'ai-live', origin: 'ai', type: 'screenshot', title: 'Caught live', visibility: 'public', stream_id: streamId, screenshot_url: 'https://media.test/s/2.jpg', ai_summary: 'The lights go out.', display_name: 'OpenVibe AI', username: null, metadata: JSON.stringify({ ai_moment: true, live: true, stream_id: streamId, offset: 42, username: 'alice', vod_link: null }) },
    human: { slug: 'human', origin: 'user', type: 'paste', title: 'My script', content: 'echo hi', language: 'bash', visibility: 'public', username: 'bob', display_name: 'Bob' },
};
pastesClient.getPaste = async (slug) => { const p = PASTES[slug]; if (!p) throw missing(); return { ...p }; };
pastesClient.listPastes = async (q = {}) => ({ pastes: (Number(q.offset) || 0) ? [] : Object.values(PASTES) });

// ── After-show reports: one AI-written, one template ──
const recap = require('../server/recap/recap');
recap.ensureTable();
const recapJson = (sid, ai, vod) => JSON.stringify({
    stream: { id: sid, title: sid === streamId ? 'Night stream' : 'Quiet stream', duration_seconds: 3600, ended_at: '2026-09-20 22:00:00', peak_viewers: 9 },
    streamer: { id: 3, username: 'alice', display_name: 'Alice' },
    write: { headline: 'Alice owns the night', summary: 'A long, loud night in chat.', grade: 'A', tags: [] },
    vod, clips: [], ai,
});
raw.prepare('INSERT INTO stream_recaps (stream_id, user_id, json, ai) VALUES (?, 3, ?, 1)').run(streamId, recapJson(streamId, true, { id: 10, thumbnail_url: null }));
raw.prepare('INSERT INTO stream_recaps (stream_id, user_id, json, ai) VALUES (?, 3, ?, 0)').run(quietStream, recapJson(quietStream, false, null));

const seo = require('../server/seo/seo');

/** Every node of a JSON-LD graph, depth first. */
function nodes(value, out = []) {
    if (Array.isArray(value)) { for (const v of value) nodes(v, out); return out; }
    if (value && typeof value === 'object') { out.push(value); for (const v of Object.values(value)) nodes(v, out); }
    return out;
}
function assertNoPerson(meta, label) {
    const all = nodes(meta.jsonLd);
    assert.ok(!all.some((n) => n['@type'] === 'Person'), `${label}: a Person in the structured data`);
    for (const n of all) {
        if (n['@type'] === 'BreadcrumbList' || n['@type'] === 'ListItem') continue;
        assert.ok(!('author' in n) && !('creator' in n), `${label}: an author or creator in ${n['@type']}`);
    }
}
const mainLd = (meta) => meta.jsonLd.find((n) => n['@type'] !== 'BreadcrumbList');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

(async () => {
    console.log('AI Moments pages');

    await check('an auto-clip is noindex,follow, canonical to its VOD at the moment, labelled AI', async () => {
        const m = await seo._pageMeta('/clip/20');
        assert.strictEqual(m.robots, 'noindex,follow');
        assert.strictEqual(m.canonicalPath, '/vod/10?t=125');
        assert.strictEqual(m.ogUrlPath, '/clip/20', 'a shared link still previews the clip');
        assert.ok(/AI clip from Alice's stream/.test(m.title), m.title);
        assert.ok(/^AI-generated clip/.test(m.description), m.description);
        assert.ok(m.snapshot.includes("AI clip · from Alice&#39;s stream"), 'the byline says what made it');
        assert.ok(m.snapshot.includes('https://openvibe.live/vod/10?t=125'), 'the page links its source');
        assert.ok(!/Clipped by/.test(m.snapshot), 'never "Clipped by" the streamer');
        assertNoPerson(m, 'auto-clip');
        const vo = mainLd(m);
        assert.strictEqual(vo.keywords, 'AI-generated');
        assert.strictEqual(vo.isBasedOn, 'https://openvibe.live/vod/10?t=125');
        const crumbs = m.jsonLd.find((n) => n['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
        assert.deepStrictEqual(crumbs.slice(0, 2), ['Home', 'AI Moments']);
    });

    await check('the rendered page carries it: robots, canonical and og:url', async () => {
        const html = seo.render(await seo._pageMeta('/clip/20'), '/clip/20');
        assert.ok(html.includes('<meta name="robots" content="noindex,follow">'));
        assert.ok(html.includes('<link rel="canonical" href="https://openvibe.live/vod/10?t=125">'));
        assert.ok(html.includes('<meta property="og:url" content="https://openvibe.live/clip/20">'));
        assert.strictEqual((html.match(/<link rel="canonical"/g) || []).length, 1, 'one canonical');
        assert.strictEqual((html.match(/<meta name="robots"/g) || []).length, 1, 'one robots tag');
    });

    await check('an auto-clip whose VOD is private keeps its own canonical (never a 404 target)', async () => {
        const m = await seo._pageMeta('/clip/22');
        assert.strictEqual(m.robots, 'noindex,follow');
        assert.strictEqual(m.canonicalPath, '/clip/22');
        assertNoPerson(m, 'auto-clip of a private VOD');
    });

    await check("a person's clip stays indexable, self-canonical, credited to the clipper", async () => {
        const m = await seo._pageMeta('/clip/21');
        assert.strictEqual(m.robots, 'index,follow');
        assert.strictEqual(m.canonicalPath, '/clip/21');
        assert.deepStrictEqual(mainLd(m).author, { '@type': 'Person', name: 'Bob' });
        assert.ok(m.snapshot.includes('Clipped by Bob'));
    });

    await check('an AI moment paste points at the VOD second it came from', async () => {
        const m = await seo._pageMeta('/p/ai-shot');
        assert.strictEqual(m.robots, 'noindex,follow');
        assert.strictEqual(m.canonicalPath, '/vod/10?t=300');
        assert.ok(/AI note from "Night stream"/.test(m.title), m.title);
        assert.ok(m.snapshot.includes('AI note · from &quot;Night stream&quot; at 5:00'), m.snapshot.slice(0, 300));
        assert.ok(!m.snapshot.includes('Shared by'), 'never "Shared by OpenVibe AI"');
        assertNoPerson(m, 'AI paste');
        assert.strictEqual(mainLd(m).keywords, 'AI-generated');
    });

    await check("a paste caught live is canonical to its stream's VOD at that second", async () => {
        const m = await seo._pageMeta('/p/ai-live');
        assert.strictEqual(m.robots, 'noindex,follow');
        assert.strictEqual(m.canonicalPath, '/vod/10?t=42');
        assert.ok(m.snapshot.includes('while the stream was live'));
        assertNoPerson(m, 'live AI paste');
    });

    await check("a person's paste stays indexable and credited", async () => {
        const m = await seo._pageMeta('/p/human');
        assert.strictEqual(m.robots, 'index,follow');
        assert.strictEqual(m.canonicalPath, '/p/human');
        assert.deepStrictEqual(mainLd(m).author, { '@type': 'Person', name: 'Bob' });
    });

    await check('an AI-written recap is noindex, canonical to the VOD, and not by the streamer', async () => {
        const m = await seo._pageMeta(`/recap/${streamId}`);
        assert.strictEqual(m.robots, 'noindex,follow');
        assert.strictEqual(m.canonicalPath, '/vod/10');
        assert.ok(/AI recap of Alice's stream/.test(m.title), m.title);
        assert.ok(m.snapshot.includes('The streamer did not write it.'));
        assertNoPerson(m, 'AI recap');
    });

    await check('a template recap (stats, no model) keeps its page indexable, still with no Person author', async () => {
        const m = await seo._pageMeta(`/recap/${quietStream}`);
        assert.strictEqual(m.robots, 'index,follow');
        assert.strictEqual(m.canonicalPath, `/recap/${quietStream}`);
        assertNoPerson(m, 'template recap');
    });

    await check("the sitemap lists people's clips only, even when Media ignores the filter", async () => {
        const xml = await seo.buildSitemap();
        assert.ok(xml.includes('/clip/21<'), "a person's clip is listed");
        assert.ok(!xml.includes('/clip/20<') && !xml.includes('/clip/22<'), 'no auto-clip');
        assert.ok(!/<loc>[^<]*\/p\//.test(xml), 'no paste at all: Community is their canonical home');
        assert.ok(xml.includes('/moments<'), 'the Moments collection is the indexable form');
        assert.ok(clipQueries.some((q) => q.auto_generated === 0), 'asked Media for people\'s clips');
    });

    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    console.log(failures ? `\n${failures} check(s) failed` : '\nseo moments: all checks passed');
    process.exit(failures ? 1 : 0);
})();
